import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';

/**
 * Prueba contra PostgreSQL real (requiere DATABASE_URL con las migraciones aplicadas).
 * Verifica que la bitácora no se pueda modificar ni por Prisma ni por SQL directo.
 */
describe.skipIf(!process.env.DATABASE_URL)('Bitácora inmutable en PostgreSQL', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const marker = `immutability-test-${Date.now()}`;

  beforeAll(async () => {
    await prisma.$connect();
    await audit.record({
      eventType: 'EXECUTE_JOIN',
      outcome: 'SUCCESS',
      workspaceId: marker,
      targetType: 'CROSS_JOIN',
      targetId: 'clientes x pedidos',
      ipAddress: '192.0.2.50',
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('el evento se insertó', async () => {
    const rows = await prisma.registroAuditoria.findMany({ where: { workspaceId: marker } });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('EXECUTE_JOIN');
  });

  it('guarda la fecha en UTC aunque el servidor de base de datos tenga otra zona horaria', async () => {
    const [row] = await prisma.registroAuditoria.findMany({ where: { workspaceId: marker } });
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(5 * 60 * 1000);
  });

  it('Prisma rechaza update y delete', async () => {
    await expect(
      prisma.registroAuditoria.updateMany({ where: { workspaceId: marker }, data: { outcome: 'FAILURE' } }),
    ).rejects.toThrow(/inmutable/);
    await expect(prisma.registroAuditoria.deleteMany({ where: { workspaceId: marker } })).rejects.toThrow(
      /inmutable/,
    );
  });

  it('PostgreSQL rechaza UPDATE, DELETE y TRUNCATE por SQL directo', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "RegistroAuditoria" SET "outcome" = 'FAILURE' WHERE "workspaceId" = $1`, marker),
    ).rejects.toThrow(/inmutable/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "RegistroAuditoria" WHERE "workspaceId" = $1`, marker),
    ).rejects.toThrow(/inmutable/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "RegistroAuditoria"`)).rejects.toThrow(/inmutable/);

    const rows = await prisma.registroAuditoria.findMany({ where: { workspaceId: marker } });
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('SUCCESS');
  });
});
