import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

describe('UsersService', () => {
  let service: UsersService;
  let prismaService: any;
  let auditService: any;

  beforeEach(() => {
    prismaService = {
      $transaction: vi.fn(),
    };
    auditService = {
      record: vi.fn().mockResolvedValue(undefined),
    };
    service = new UsersService(
      prismaService as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  it('blocks role changes from a LECTOR without opening a transaction', async () => {
    await expect(
      service.updateRole(
        {
          id: 'lector-1',
          email: 'lector@example.com',
          name: 'Reader',
          role: 'LECTOR',
          workspaceId: 'workspace-1',
        },
        'user-2',
        'ADMIN',
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(prismaService.$transaction).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('does not allow an ADMIN to change their own role', async () => {
    await expect(
      service.updateRole(
        {
          id: 'admin-1',
          email: 'admin@example.com',
          name: 'Admin',
          role: 'ADMIN',
          workspaceId: 'workspace-1',
        },
        'admin-1',
        'LECTOR',
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(prismaService.$transaction).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('updates and audits a role change for an ADMIN in the same workspace', async () => {
    const targetBefore = {
      id: 'user-2',
      email: 'reader@example.com',
      name: 'Reader',
      role: 'LECTOR',
      workspaceId: 'workspace-1',
    };
    const targetAfter = { ...targetBefore, role: 'ADMIN' };
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue(targetBefore),
        update: vi.fn().mockResolvedValue(targetAfter),
      },
    };
    prismaService.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    const result = await service.updateRole(
      {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        role: 'ADMIN',
        workspaceId: 'workspace-1',
      },
      'user-2',
      'ADMIN',
      { ipAddress: '192.0.2.10', userAgent: 'phase3-test' },
    );

    expect(result).toEqual(targetAfter);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-2' },
      data: { role: 'ADMIN' },
      select: { id: true, email: true, name: true, role: true, workspaceId: true },
    });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'USER_ROLE_CHANGED',
        outcome: 'SUCCESS',
        actorUserId: 'admin-1',
        targetType: 'USER',
        targetId: 'user-2',
        workspaceId: 'workspace-1',
        details: { previousRole: 'LECTOR', newRole: 'ADMIN' },
        ipAddress: '192.0.2.10',
        userAgent: 'phase3-test',
      }),
      tx,
    );
  });

  it('hides role targets that belong to another workspace', async () => {
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-2',
          email: 'other@example.com',
          name: 'Other',
          role: 'LECTOR',
          workspaceId: 'workspace-2',
        }),
        update: vi.fn(),
      },
    };
    prismaService.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await expect(
      service.updateRole(
        {
          id: 'admin-1',
          email: 'admin@example.com',
          name: 'Admin',
          role: 'ADMIN',
          workspaceId: 'workspace-1',
        },
        'user-2',
        'ADMIN',
      ),
    ).rejects.toThrow(NotFoundException);

    expect(tx.user.update).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  describe('findAll', () => {
    it('returns all members of the actor workspace', async () => {
      const mockUsers = [
        { id: 'u1', name: 'User 1', email: 'u1@ws.com', role: 'ADMIN', workspaceId: 'ws-1', lockedUntil: null, sessions: [] },
        { id: 'u2', name: 'User 2', email: 'u2@ws.com', role: 'LECTOR', workspaceId: 'ws-1', lockedUntil: null, sessions: [{ lastActivityAt: new Date('2026-11-07T10:00:00Z'), revokedAt: null, expiresAt: new Date('2999-01-01T00:00:00Z') }] },
      ];
      prismaService.user = { findMany: vi.fn().mockResolvedValue(mockUsers) };

      const result = await service.findAll({
        id: 'u1',
        email: 'u1@ws.com',
        name: 'User 1',
        role: 'ADMIN',
        workspaceId: 'ws-1',
      });

      expect(prismaService.user.findMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        select: expect.any(Object),
        orderBy: { name: 'asc' },
      });
      expect(result).toHaveLength(2);
      expect(result[1]).toMatchObject({ sesionesActivas: 1, ultimoAcceso: new Date('2026-11-07T10:00:00Z'), bloqueado: false, esUstedMismo: false });
      expect(result[0]).toMatchObject({ sesionesActivas: 0, ultimoAcceso: null, esUstedMismo: true });
    });
  });

  describe('removeMember', () => {
    const admin = { id: 'admin-1', email: 'admin@acme.com', name: 'Admin', role: 'ADMIN' as const, workspaceId: 'ws-1' };
    let tx: any;

    beforeEach(() => {
      tx = {
        user: {
          findUnique: vi.fn(),
          delete: vi.fn().mockResolvedValue(undefined),
        },
        $queryRaw: vi.fn(),
      };
      prismaService.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) => callback(tx));
    });

    it.each(['OPERADOR', 'LECTOR', 'AUDITOR'] as const)('rechaza a %s sin abrir transacción', async (role) => {
      await expect(service.removeMember({ ...admin, role }, 'user-2')).rejects.toThrow(ForbiddenException);
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });

    it('no permite darse de baja a uno mismo', async () => {
      await expect(service.removeMember(admin, 'admin-1')).rejects.toThrow(ForbiddenException);
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });

    it('responde 404 para usuarios de otro workspace', async () => {
      tx.user.findUnique.mockResolvedValue({ id: 'u-9', email: 'x@otra.com', name: 'X', role: 'LECTOR', workspaceId: 'ws-2' });
      await expect(service.removeMember(admin, 'u-9')).rejects.toThrow(NotFoundException);
      expect(tx.user.delete).not.toHaveBeenCalled();
    });

    it('da de baja a un LECTOR sin consultar ADMIN y lo audita', async () => {
      const target = { id: 'u-2', email: 'lector@acme.com', name: 'Lector', role: 'LECTOR', workspaceId: 'ws-1' };
      tx.user.findUnique.mockResolvedValue(target);

      await expect(service.removeMember(admin, 'u-2', { ipAddress: '10.0.0.1' })).resolves.toEqual(target);

      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'u-2' } });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'USER_REMOVED',
          targetId: 'u-2',
          ipAddress: '10.0.0.1',
          details: { email: 'lector@acme.com', role: 'LECTOR' },
        }),
        tx,
      );
    });

    it('no elimina al último ADMINISTRADOR (409)', async () => {
      tx.user.findUnique.mockResolvedValue({ id: 'admin-2', email: 'a2@acme.com', name: 'A2', role: 'ADMIN', workspaceId: 'ws-1' });
      tx.$queryRaw.mockResolvedValue([{ id: 'admin-2' }]);

      await expect(service.removeMember(admin, 'admin-2')).rejects.toThrow(ConflictException);
      expect(tx.user.delete).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('elimina a un ADMIN si queda otro, bloqueando las filas de ADMIN', async () => {
      tx.user.findUnique.mockResolvedValue({ id: 'admin-2', email: 'a2@acme.com', name: 'A2', role: 'ADMIN', workspaceId: 'ws-1' });
      tx.$queryRaw.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);

      await service.removeMember(admin, 'admin-2');

      const [sql] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray];
      expect(sql.join('?')).toContain('FOR UPDATE');
      expect(tx.user.delete).toHaveBeenCalled();
    });
  });

  describe('updateRole y el último ADMINISTRADOR', () => {
    it('no permite quitar el rol al último ADMIN', async () => {
      const tx = {
        user: {
          findUnique: vi.fn().mockResolvedValue({ id: 'admin-2', email: 'a2@acme.com', name: 'A2', role: 'ADMIN', workspaceId: 'ws-1' }),
          update: vi.fn(),
        },
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'admin-2' }]),
      };
      prismaService.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) => callback(tx));

      await expect(
        service.updateRole(
          { id: 'admin-1', email: 'admin@acme.com', name: 'Admin', role: 'ADMIN', workspaceId: 'ws-1' },
          'admin-2',
          'LECTOR',
        ),
      ).rejects.toThrow(ConflictException);
      expect(tx.user.update).not.toHaveBeenCalled();
    });
  });
});
