import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  let service: AuditService;
  let prismaService: { $executeRaw: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    prismaService = {
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    service = new AuditService(prismaService as unknown as PrismaService);
  });

  it('persists only safe, allowlisted details for connection updates', async () => {
    await service.record({
      eventType: 'CONNECTION_UPDATED',
      outcome: 'SUCCESS',
      actorUserId: 'user-1',
      workspaceId: 'workspace-1',
      targetType: 'CONNECTION',
      targetId: 'connection-1',
      details: {
        changedFields: ['dbName', 'connectionString'],
        connectionString: 'Server=host;Password=do-not-store',
        connectionStringEncriptada: 'ciphertext-do-not-store',
        password: 'do-not-store',
      },
    });

    expect(prismaService.$executeRaw).toHaveBeenCalledOnce();
    const [queryTemplate, ...queryValues] = prismaService.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(queryTemplate.join('?')).toContain('INSERT INTO "RegistroAuditoria"');
    expect(queryValues).toContain('{"changedFields":["dbName","connectionString"]}');
    expect(queryValues).not.toContain('Server=host;Password=do-not-store');
    expect(queryValues).not.toContain('ciphertext-do-not-store');
    expect(queryValues).not.toContain('do-not-store');
  });

  it('writes through the supplied transaction client', async () => {
    const transactionExecute = vi.fn().mockResolvedValue(1);
    const transaction = {
      $executeRaw: transactionExecute,
    } as unknown as Prisma.TransactionClient;

    await service.record(
      {
        eventType: 'LOGIN_FAILURE',
        outcome: 'FAILURE',
        actorEmail: 'missing@example.com',
        details: { password: 'do-not-store' },
      },
      transaction,
    );

    expect(transactionExecute).toHaveBeenCalledOnce();
    const [, ...queryValues] = transactionExecute.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(queryValues).toContain('missing@example.com');
    expect(queryValues).not.toContain('do-not-store');
    expect(prismaService.$executeRaw).not.toHaveBeenCalled();
  });
});
