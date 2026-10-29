import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
        { id: 'u1', name: 'User 1', email: 'u1@ws.com', role: 'ADMIN', workspaceId: 'ws-1' },
        { id: 'u2', name: 'User 2', email: 'u2@ws.com', role: 'LECTOR', workspaceId: 'ws-1' },
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
    });
  });

  describe('inviteMember', () => {
    it('blocks non-admin from inviting members', async () => {
      await expect(
        service.inviteMember(
          { id: 'u2', email: 'u2@ws.com', name: 'User 2', role: 'LECTOR', workspaceId: 'ws-1' },
          { email: 'new@ws.com', name: 'New', role: 'LECTOR' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('creates new user and records audit log for ADMIN', async () => {
      prismaService.user = {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'u-new',
          email: 'new@ws.com',
          name: 'New User',
          role: 'LECTOR',
          workspaceId: 'ws-1',
        }),
      };

      const result = await service.inviteMember(
        { id: 'u1', email: 'u1@ws.com', name: 'Admin', role: 'ADMIN', workspaceId: 'ws-1' },
        { email: 'new@ws.com', name: 'New User', role: 'LECTOR' },
      );

      expect(prismaService.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'new@ws.com',
          name: 'New User',
          role: 'LECTOR',
          workspaceId: 'ws-1',
        }),
        select: expect.any(Object),
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'USER_ROLE_CHANGED',
          outcome: 'SUCCESS',
          actorUserId: 'u1',
        }),
      );
      expect(result.id).toBe('u-new');
    });
  });
});
