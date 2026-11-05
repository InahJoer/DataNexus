import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConnectionsService } from './connections.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../common/encryption/encryption.service.js';
import { AuditService } from '../audit/audit.service.js';

const admin = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'ADMIN',
  workspaceId: 'workspace-1',
};

const connection = {
  id: 'connection-1',
  tipoMotor: 'PostgreSQL',
  host: 'db.internal',
  dbName: 'analytics',
  connectionStringEncriptada: 'ciphertext-do-not-return',
  workspaceId: 'workspace-1',
};

describe('ConnectionsService', () => {
  let service: ConnectionsService;
  let prismaService: any;
  let encryptionService: any;
  let auditService: any;

  beforeEach(() => {
    prismaService = {
      $transaction: vi.fn(),
      workspace: { findUnique: vi.fn() },
      conexionDB: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    encryptionService = {
      encrypt: vi.fn().mockImplementation((text: string) => `encrypted_${text}`),
      decrypt: vi.fn().mockImplementation((text: string) => text.replace('encrypted_', '')),
    };
    auditService = { record: vi.fn().mockResolvedValue(undefined) };
    service = new ConnectionsService(
      prismaService as unknown as PrismaService,
      encryptionService as unknown as EncryptionService,
      auditService as unknown as AuditService,
    );
  });

  it('lists only the authenticated workspace and excludes encrypted credentials', async () => {
    prismaService.conexionDB.findMany.mockResolvedValue([
      {
        id: connection.id,
        tipoMotor: connection.tipoMotor,
        host: connection.host,
        dbName: connection.dbName,
        workspaceId: connection.workspaceId,
      },
    ]);

    const result = await service.findAll(admin);

    expect(prismaService.conexionDB.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-1' },
      select: {
        id: true,
        tipoMotor: true,
        host: true,
        dbName: true,
        workspaceId: true,
      },
      orderBy: { id: 'desc' },
    });
    expect(result[0]).not.toHaveProperty('connectionStringEncriptada');
  });

  it('creates a connection and audits it in the same transaction without credentials', async () => {
    const tx = {
      workspace: { findUnique: vi.fn().mockResolvedValue({ id: 'workspace-1' }) },
      conexionDB: {
        create: vi.fn().mockResolvedValue({
          id: connection.id,
          tipoMotor: connection.tipoMotor,
          host: connection.host,
          dbName: connection.dbName,
          workspaceId: connection.workspaceId,
        }),
      },
    };
    prismaService.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    const result = await service.create(
      admin,
      {
        tipoMotor: 'PostgreSQL',
        host: 'db.internal',
        dbName: 'analytics',
        connectionString: 'postgres://admin:secret@db.internal/analytics',
      },
      { ipAddress: '192.0.2.10', userAgent: 'phase3-test' },
    );

    expect(tx.conexionDB.create).toHaveBeenCalledWith({
      data: {
        tipoMotor: 'PostgreSQL',
        host: 'db.internal',
        dbName: 'analytics',
        connectionStringEncriptada:
          'encrypted_postgres://admin:secret@db.internal/analytics',
        workspaceId: 'workspace-1',
      },
      select: {
        id: true,
        tipoMotor: true,
        host: true,
        dbName: true,
        workspaceId: true,
      },
    });
    expect(result).not.toHaveProperty('connectionStringEncriptada');
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'CONNECTION_CREATED',
        outcome: 'SUCCESS',
        actorUserId: 'admin-1',
        workspaceId: 'workspace-1',
        targetType: 'CONNECTION',
        targetId: 'connection-1',
        details: { tipoMotor: 'PostgreSQL', dbName: 'analytics' },
        ipAddress: '192.0.2.10',
        userAgent: 'phase3-test',
      }),
      tx,
    );
    expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('secret@db.internal');
  });

  it('rejects connection creation by a LECTOR', async () => {
    await expect(
      service.create(
        { ...admin, role: 'LECTOR' },
        {
          tipoMotor: 'PostgreSQL',
          host: 'db.internal',
          dbName: 'analytics',
          connectionString: 'postgres://secret',
        },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(prismaService.$transaction).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('audits modified field names in the same transaction, never credential values', async () => {
    const tx = {
      conexionDB: {
        findFirst: vi.fn().mockResolvedValue(connection),
        update: vi.fn().mockResolvedValue({
          id: connection.id,
          tipoMotor: connection.tipoMotor,
          host: connection.host,
          dbName: 'analytics_v2',
          workspaceId: connection.workspaceId,
        }),
      },
    };
    prismaService.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    const result = await service.update(
      admin,
      'connection-1',
      {
        dbName: 'analytics_v2',
        connectionString: 'postgres://admin:new-secret@db.internal/analytics_v2',
      },
    );

    expect(tx.conexionDB.findFirst).toHaveBeenCalledWith({
      where: { id: 'connection-1', workspaceId: 'workspace-1' },
      select: {
        id: true,
        tipoMotor: true,
        host: true,
        dbName: true,
      },
    });
    expect(tx.conexionDB.update).toHaveBeenCalledWith({
      where: { id: 'connection-1' },
      data: {
        dbName: 'analytics_v2',
        connectionStringEncriptada:
          'encrypted_postgres://admin:new-secret@db.internal/analytics_v2',
      },
      select: {
        id: true,
        tipoMotor: true,
        host: true,
        dbName: true,
        workspaceId: true,
      },
    });
    expect(result).not.toHaveProperty('connectionStringEncriptada');
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'CONNECTION_UPDATED',
        targetId: 'connection-1',
        details: { changedFields: ['dbName', 'connectionString'] },
      }),
      tx,
    );
    expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('new-secret');
  });

  it('deletes a connection and records its safe metadata before commit', async () => {
    const tx = {
      conexionDB: {
        findFirst: vi.fn().mockResolvedValue(connection),
        delete: vi.fn().mockResolvedValue({
          id: connection.id,
          tipoMotor: connection.tipoMotor,
          host: connection.host,
          dbName: connection.dbName,
          workspaceId: connection.workspaceId,
        }),
      },
    };
    prismaService.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    const result = await service.remove(admin, 'connection-1');

    expect(tx.conexionDB.delete).toHaveBeenCalledWith({
      where: { id: 'connection-1' },
      select: {
        id: true,
        tipoMotor: true,
        host: true,
        dbName: true,
        workspaceId: true,
      },
    });
    expect(result).not.toHaveProperty('connectionStringEncriptada');
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'CONNECTION_DELETED',
        targetId: 'connection-1',
        details: { tipoMotor: 'PostgreSQL', dbName: 'analytics' },
      }),
      tx,
    );
  });

  it('does not find connections outside the authenticated workspace', async () => {
    prismaService.conexionDB.findFirst.mockResolvedValue(null);

    await expect(service.findOne(admin, 'connection-from-another-workspace')).rejects.toThrow(
      NotFoundException,
    );

    expect(prismaService.conexionDB.findFirst).toHaveBeenCalledWith({
      where: { id: 'connection-from-another-workspace', workspaceId: 'workspace-1' },
      select: {
        id: true,
        tipoMotor: true,
        host: true,
        dbName: true,
        workspaceId: true,
      },
    });
  });

  it('decrypts credentials only after a workspace-scoped internal lookup', async () => {
    prismaService.conexionDB.findFirst.mockResolvedValue(connection);

    const result = await service.getConnectionForExploration(
      'connection-1',
      'workspace-1',
    );

    expect(prismaService.conexionDB.findFirst).toHaveBeenCalledWith({
      where: { id: 'connection-1', workspaceId: 'workspace-1' },
      select: {
        id: true,
        tipoMotor: true,
        dbName: true,
        connectionStringEncriptada: true,
      },
    });
    expect(result).toEqual({
      id: 'connection-1',
      tipoMotor: 'PostgreSQL',
      dbName: 'analytics',
      connectionString: 'ciphertext-do-not-return',
    });
    expect(result).not.toHaveProperty('connectionStringEncriptada');
  });
});
