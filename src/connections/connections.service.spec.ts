import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConnectionsService } from './connections.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../common/encryption/encryption.service.js';

describe('ConnectionsService', () => {
  let service: ConnectionsService;
  let prismaService: any;
  let encryptionService: any;

  beforeEach(() => {
    prismaService = {
      workspace: {
        findUnique: vi.fn(),
      },
      conexionDB: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };

    encryptionService = {
      encrypt: vi.fn().mockImplementation((text: string) => `encrypted_${text}`),
      decrypt: vi.fn().mockImplementation((text: string) => text.replace('encrypted_', '')),
    };

    service = new ConnectionsService(
      prismaService as unknown as PrismaService,
      encryptionService as unknown as EncryptionService,
    );
  });

  it('debe estar definido', () => {
    expect(service).toBeDefined();
  });

  it('debe encriptar la connectionString y persistir solo la versión cifrada (RNF-01)', async () => {
    const rawConnectionString = 'Server=localhost;Database=test;User=sa;Password=secret;';
    const workspaceId = 'ws-uuid-1';

    prismaService.workspace.findUnique.mockResolvedValue({
      id: workspaceId,
      nombreEmpresa: 'DataNexus Corp',
    });

    prismaService.conexionDB.create.mockImplementation(({ data }: any) => {
      return Promise.resolve({
        id: 'conn-uuid-1',
        ...data,
      });
    });

    const result = await service.create({
      tipoMotor: 'SQLServer',
      host: 'localhost',
      dbName: 'test',
      connectionString: rawConnectionString,
      workspaceId,
    });

    expect(encryptionService.encrypt).toHaveBeenCalledWith(rawConnectionString);
    expect(prismaService.conexionDB.create).toHaveBeenCalledWith({
      data: {
        tipoMotor: 'SQLServer',
        host: 'localhost',
        dbName: 'test',
        connectionStringEncriptada: `encrypted_${rawConnectionString}`,
        workspaceId,
      },
    });
    expect(result.connectionStringEncriptada).toEqual(`encrypted_${rawConnectionString}`);
  });

  it('debe lanzar NotFoundException si el Workspace no existe al crear', async () => {
    prismaService.workspace.findUnique.mockResolvedValue(null);

    await expect(
      service.create({
        tipoMotor: 'SQLServer',
        host: 'localhost',
        dbName: 'test',
        connectionString: 'secret',
        workspaceId: 'inexistente',
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
