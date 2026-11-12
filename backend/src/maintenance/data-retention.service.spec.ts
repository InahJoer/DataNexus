import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { DataRetentionService, RETENTION_BATCH_SIZE, SESSION_RETENTION_DAYS } from './data-retention.service.js';

const NOW = new Date('2026-11-12T03:30:00.000Z');
const CUTOFF = new Date(NOW.getTime() - SESSION_RETENTION_DAYS * 86_400_000);
const ids = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));

/** Modelo falso: devuelve los lotes en orden y cuenta lo que se borra. */
function fakeModel(batches: { id: string }[][] = []) {
  const queue = [...batches];
  return {
    findMany: vi.fn(async (_args: unknown) => queue.shift() ?? []),
    deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length })),
  };
}

function setup(sesiones: { id: string }[][] = [], tokens: { id: string }[][] = []) {
  const prisma = {
    registroAuditoria: fakeModel(),
    userSession: fakeModel(sesiones),
    passwordResetToken: fakeModel(tokens),
  };
  return { prisma, service: new DataRetentionService(prisma as unknown as PrismaService) };
}

describe('DataRetentionService', () => {
  it('borra sesiones vencidas o revocadas y tokens de recuperación caducados o ya usados', async () => {
    const { prisma, service } = setup([ids(2, 's')], [ids(1, 't')]);

    await expect(service.run(NOW)).resolves.toEqual({ sesiones: 2, tokensRecuperacion: 1 });

    expect(prisma.userSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ expiresAt: { lt: CUTOFF } }, { revokedAt: { lt: CUTOFF } }] } }),
    );
    expect(prisma.passwordResetToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ expiresAt: { lt: NOW } }, { usedAt: { lt: CUTOFF } }] } }),
    );
    expect(prisma.userSession.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s-0', 's-1'] } } });
  });

  it('nunca toca la bitácora de auditoría (inmutable, RF-26)', async () => {
    const { prisma, service } = setup([ids(1, 's')]);
    await service.run(NOW);
    expect(prisma.registroAuditoria.findMany).not.toHaveBeenCalled();
    expect(prisma.registroAuditoria.deleteMany).not.toHaveBeenCalled();
  });

  it('borra por lotes hasta que no queda nada', async () => {
    const { prisma, service } = setup([ids(RETENTION_BATCH_SIZE, 'x'), ids(RETENTION_BATCH_SIZE, 'y'), ids(10, 'z')]);

    const result = await service.run(NOW);

    expect(result.sesiones).toBe(RETENTION_BATCH_SIZE * 2 + 10);
    expect(prisma.userSession.deleteMany).toHaveBeenCalledTimes(3);
    for (const [args] of prisma.userSession.findMany.mock.calls) expect(args).toMatchObject({ take: RETENTION_BATCH_SIZE });
  });

  it('reutiliza la limpieza en curso en lugar de lanzar otra', async () => {
    const { prisma, service } = setup();
    const first = service.run(NOW);
    expect(service.run(NOW)).toBe(first);
    await first;
    expect(prisma.userSession.findMany).toHaveBeenCalledTimes(1);
  });

  it('la ejecución programada registra el error sin propagarlo (la base puede estar caída)', async () => {
    const { prisma, service } = setup();
    prisma.userSession.findMany.mockRejectedValueOnce(new Error('No space left on device'));
    await expect(service.runScheduled()).resolves.toBeUndefined();
  });
});
