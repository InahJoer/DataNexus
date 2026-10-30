import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';

describe('AuditService', () => {
  let service: AuditService;
  let prismaService: {
    $executeRaw: ReturnType<typeof vi.fn>;
    registroAuditoria: {
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };

  const adminUser: AuthenticatedUser = {
    id: 'admin-1',
    email: 'admin@corp.com',
    name: 'Admin',
    role: 'ADMIN',
    workspaceId: 'workspace-1',
  };

  const lectorUser: AuthenticatedUser = {
    id: 'lector-1',
    email: 'lector@corp.com',
    name: 'Lector',
    role: 'LECTOR',
    workspaceId: 'workspace-1',
  };

  beforeEach(() => {
    prismaService = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      registroAuditoria: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
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

  describe('findAll pagination and filters', () => {
    it('throws ForbiddenException when actor is not ADMIN', async () => {
      await expect(service.findAll(lectorUser, { page: 1, limit: 10 })).rejects.toThrow(
        ForbiddenException,
      );
      expect(prismaService.registroAuditoria.findMany).not.toHaveBeenCalled();
    });

    it('queries with correct skip and take pagination for ADMIN', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          eventType: 'LOGIN_SUCCESS',
          outcome: 'SUCCESS',
          actorUserId: 'admin-1',
          actorEmail: 'admin@corp.com',
          workspaceId: 'workspace-1',
          targetType: null,
          targetId: null,
          detailsJson: null,
          ipAddress: '127.0.0.1',
          userAgent: 'test-agent',
          createdAt: new Date('2026-10-10T12:00:00Z'),
        },
      ];
      prismaService.registroAuditoria.count.mockResolvedValue(100);
      prismaService.registroAuditoria.findMany.mockResolvedValue(mockLogs);

      const result = await service.findAll(adminUser, { page: 2, limit: 25 });

      expect(prismaService.registroAuditoria.count).toHaveBeenCalledWith({
        where: { workspaceId: 'workspace-1' },
      });
      expect(prismaService.registroAuditoria.findMany).toHaveBeenCalledWith({
        where: { workspaceId: 'workspace-1' },
        skip: 25,
        take: 25,
        orderBy: { createdAt: 'desc' },
      });

      expect(result.total).toBe(100);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(25);
      expect(result.totalPages).toBe(4);
      expect(result.data).toEqual(mockLogs);
    });

    it('filters by fechaInicio, fechaFin and tipoAccion', async () => {
      prismaService.registroAuditoria.count.mockResolvedValue(1);
      prismaService.registroAuditoria.findMany.mockResolvedValue([]);

      await service.findAll(adminUser, {
        page: 1,
        limit: 10,
        fechaInicio: '2026-10-01T00:00:00.000Z',
        fechaFin: '2026-10-31T23:59:59.000Z',
        tipoAccion: 'CONNECTION_DELETED',
      });

      expect(prismaService.registroAuditoria.findMany).toHaveBeenCalledWith({
        where: {
          workspaceId: 'workspace-1',
          eventType: 'CONNECTION_DELETED',
          createdAt: {
            gte: new Date('2026-10-01T00:00:00.000Z'),
            lte: new Date('2026-10-31T23:59:59.000Z'),
          },
        },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
      });
    });
  });
});
