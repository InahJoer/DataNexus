import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConnectionsService } from './connections.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../common/encryption/encryption.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { serializeCredentials } from './credentials/connection-credentials.js';

const admin: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'ADMIN',
  workspaceId: 'workspace-1',
};

const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
const serviceAccount = {
  type: 'service_account',
  project_id: 'datanexus-demo',
  private_key_id: 'abc123',
  private_key: PRIVATE_KEY,
  client_email: 'lector@datanexus-demo.iam.gserviceaccount.com',
  client_id: '1234567890',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
};

const pgCredentials = {
  host: 'db.internal',
  database: 'analytics',
  username: 'lector_bi',
  password: 'S3creta#2026',
};

const savedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'connection-1',
  nombre: null,
  tipoMotor: 'POSTGRESQL',
  host: 'db.internal',
  dbName: 'analytics',
  workspaceId: 'workspace-1',
  credencialesVersion: 2,
  detalles: { puerto: 5432, usuario: 'lector_bi', ssl: false },
  ...overrides,
});

describe('ConnectionsService', () => {
  let service: ConnectionsService;
  let prismaService: any;
  let encryptionService: any;
  let auditService: any;
  let tx: any;

  beforeEach(() => {
    tx = {
      workspace: { findUnique: vi.fn().mockResolvedValue({ id: 'workspace-1' }) },
      conexionDB: {
        create: vi.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve(savedRow(data))),
        findFirst: vi.fn(),
        update: vi.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve(savedRow(data))),
        delete: vi.fn().mockResolvedValue(savedRow()),
      },
    };
    prismaService = {
      $transaction: vi.fn((callback: (client: unknown) => unknown) => callback(tx)),
      conexionDB: { findMany: vi.fn(), findFirst: vi.fn() },
    };
    encryptionService = {
      encrypt: vi.fn((text: string) => `encrypted_${text}`),
      decrypt: vi.fn((text: string) => text.replace(/^encrypted_/, '')),
    };
    auditService = { record: vi.fn().mockResolvedValue(undefined) };
    service = new ConnectionsService(
      prismaService as unknown as PrismaService,
      encryptionService as unknown as EncryptionService,
      auditService as unknown as AuditService,
    );
  });

  const storedPayload = () => {
    const data = tx.conexionDB.create.mock.calls[0]?.[0].data ?? tx.conexionDB.update.mock.calls[0][0].data;
    return JSON.parse((data.connectionStringEncriptada as string).replace(/^encrypted_/, ''));
  };

  describe('create', () => {
    it('cifra todo el payload, guarda metadatos no secretos y audita sin credenciales', async () => {
      const result = await service.create(
        admin,
        { tipoMotor: 'POSTGRESQL', credenciales: { ...pgCredentials, ssl: true } },
        { ipAddress: '192.0.2.10', userAgent: 'test' },
      );

      const data = tx.conexionDB.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        tipoMotor: 'POSTGRESQL',
        host: 'db.internal',
        dbName: 'analytics',
        credencialesVersion: 2,
        detalles: { puerto: 5432, usuario: 'lector_bi', ssl: true },
        workspaceId: 'workspace-1',
      });
      expect(storedPayload()).toEqual({
        v: 2,
        tipoMotor: 'POSTGRESQL',
        credentials: { ...pgCredentials, port: 5432, ssl: true },
      });
      expect(JSON.stringify(data.detalles)).not.toContain('S3creta');

      expect(result).toMatchObject({ formatoCredenciales: 'ESTRUCTURADO', host: 'db.internal' });
      expect(result).not.toHaveProperty('connectionStringEncriptada');
      expect(JSON.stringify(result)).not.toContain('S3creta');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'CONNECTION_CREATED',
          details: { tipoMotor: 'POSTGRESQL', dbName: 'analytics' },
          ipAddress: '192.0.2.10',
        }),
        tx,
      );
      expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('S3creta');
    });

    it('rechaza credenciales de otro motor (400) sin tocar la base', async () => {
      await expect(
        service.create(admin, { tipoMotor: 'MYSQL', credenciales: { uri: 'mongodb://x', database: 'y' } }),
      ).rejects.toThrow(BadRequestException);
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });

    it('acepta el Service Account como JSON y descarta campos innecesarios', async () => {
      const result = await service.create(admin, {
        tipoMotor: 'FIRESTORE',
        credenciales: { serviceAccount },
      });

      expect(storedPayload().credentials.serviceAccount).not.toHaveProperty('auth_uri');
      expect(tx.conexionDB.create.mock.calls[0][0].data).toMatchObject({
        host: 'firestore.googleapis.com',
        dbName: '(default)',
        detalles: { projectId: 'datanexus-demo', clientEmail: serviceAccount.client_email },
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
    });

    it('rechaza la creación por un LECTOR', async () => {
      await expect(
        service.create({ ...admin, role: 'LECTOR' }, { tipoMotor: 'POSTGRESQL', credenciales: pgCredentials }),
      ).rejects.toThrow(ForbiddenException);
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('createFirestoreFromUpload', () => {
    const file = (content: string, extra: Record<string, unknown> = {}) => ({
      originalname: 'sa.json',
      mimetype: 'application/json',
      size: content.length,
      buffer: Buffer.from(content, 'utf8'),
      ...extra,
    });

    it('crea la conexión a partir del archivo en memoria', async () => {
      await service.createFirestoreFromUpload(admin, file(JSON.stringify(serviceAccount)), {
        nombre: 'App móvil',
        databaseId: 'ventas-db',
      });
      expect(tx.conexionDB.create.mock.calls[0][0].data).toMatchObject({
        nombre: 'App móvil',
        tipoMotor: 'FIRESTORE',
        dbName: 'ventas-db',
      });
      expect(storedPayload().credentials.serviceAccount.project_id).toBe('datanexus-demo');
    });

    it('acepta archivos con BOM', async () => {
      await service.createFirestoreFromUpload(admin, file(`﻿${JSON.stringify(serviceAccount)}`), {});
      expect(tx.conexionDB.create).toHaveBeenCalled();
    });

    it.each([
      ['sin archivo', undefined],
      ['JSON inválido', { originalname: 'sa.json', mimetype: 'application/json', size: 3, buffer: Buffer.from('{x') }],
      ['guardado en disco', { originalname: 'sa.json', mimetype: 'application/json', size: 3, path: '/tmp/sa.json' }],
    ])('rechaza el caso "%s" con 400', async (_label, upload) => {
      await expect(service.createFirestoreFromUpload(admin, upload as never, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza credenciales que no son de tipo service_account', async () => {
      const userCredential = { ...serviceAccount, type: 'authorized_user' };
      const error = await service
        .createFirestoreFromUpload(admin, file(JSON.stringify(userCredential)), {})
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((error as BadRequestException).getResponse())).toContain('service_account');
    });
  });

  describe('update', () => {
    const structuredCiphertext = () =>
      `encrypted_${serializeCredentials('POSTGRESQL', { ...pgCredentials, port: 5432, ssl: false })}`;

    it('rota solo la contraseña conservando el resto de credenciales', async () => {
      tx.conexionDB.findFirst.mockResolvedValue({
        id: 'connection-1',
        tipoMotor: 'POSTGRESQL',
        connectionStringEncriptada: structuredCiphertext(),
      });

      await service.update(admin, 'connection-1', { credenciales: { password: 'Nueva#2026x' } });

      expect(storedPayload().credentials).toEqual({ ...pgCredentials, port: 5432, ssl: false, password: 'Nueva#2026x' });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'CONNECTION_UPDATED', details: { changedFields: ['credenciales'] } }),
        tx,
      );
      expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('Nueva#2026x');
    });

    it('una conexión LEGADO necesita credenciales completas', async () => {
      tx.conexionDB.findFirst.mockResolvedValue({
        id: 'connection-1',
        tipoMotor: 'POSTGRESQL',
        connectionStringEncriptada: 'encrypted_postgres://u:p@db/analytics',
      });

      await expect(service.update(admin, 'connection-1', { credenciales: { password: 'x' } })).rejects.toThrow(
        BadRequestException,
      );
      await service.update(admin, 'connection-1', { credenciales: pgCredentials });
      expect(tx.conexionDB.update.mock.calls[0][0].data).toMatchObject({ credencialesVersion: 2 });
    });

    it('cambiar de motor exige credenciales', async () => {
      tx.conexionDB.findFirst.mockResolvedValue({
        id: 'connection-1',
        tipoMotor: 'POSTGRESQL',
        connectionStringEncriptada: structuredCiphertext(),
      });
      await expect(service.update(admin, 'connection-1', { tipoMotor: 'MYSQL' })).rejects.toThrow(
        /credenciales completas/,
      );
    });

    it('al cambiar de motor no mezcla credenciales del motor anterior', async () => {
      tx.conexionDB.findFirst.mockResolvedValue({
        id: 'connection-1',
        tipoMotor: 'POSTGRESQL',
        connectionStringEncriptada: structuredCiphertext(),
      });
      await expect(
        service.update(admin, 'connection-1', { tipoMotor: 'MONGODB', credenciales: { database: 'x' } }),
      ).rejects.toThrow(BadRequestException);
    });

    it('cambiar solo el nombre no toca las credenciales', async () => {
      tx.conexionDB.findFirst.mockResolvedValue({
        id: 'connection-1',
        tipoMotor: 'POSTGRESQL',
        connectionStringEncriptada: structuredCiphertext(),
      });
      await service.update(admin, 'connection-1', { nombre: 'Nuevo nombre' });
      expect(tx.conexionDB.update.mock.calls[0][0].data).toEqual({ nombre: 'Nuevo nombre' });
    });

    it('busca solo en el workspace del actor', async () => {
      tx.conexionDB.findFirst.mockResolvedValue(null);
      await expect(service.update(admin, 'otra', { nombre: 'x' })).rejects.toThrow(NotFoundException);
      expect(tx.conexionDB.findFirst.mock.calls[0][0].where).toEqual({ id: 'otra', workspaceId: 'workspace-1' });
    });
  });

  describe('replaceServiceAccount', () => {
    const upload = {
      originalname: 'sa.json',
      mimetype: 'application/json',
      size: 10,
      buffer: Buffer.from(JSON.stringify({ ...serviceAccount, client_email: 'nuevo@datanexus-demo.iam.gserviceaccount.com' })),
    };

    it('sustituye la cuenta de servicio de una conexión Firestore', async () => {
      tx.conexionDB.findFirst.mockResolvedValue({ id: 'c-1', tipoMotor: 'FIRESTORE', dbName: 'ventas-db' });
      await service.replaceServiceAccount(admin, 'c-1', upload, {});
      expect(storedPayload().credentials).toMatchObject({
        databaseId: 'ventas-db',
        serviceAccount: { client_email: 'nuevo@datanexus-demo.iam.gserviceaccount.com' },
      });
    });

    it('rechaza conexiones que no son Firestore', async () => {
      tx.conexionDB.findFirst.mockResolvedValue({ id: 'c-1', tipoMotor: 'POSTGRESQL', dbName: 'x' });
      await expect(service.replaceServiceAccount(admin, 'c-1', upload, {})).rejects.toThrow(BadRequestException);
      expect(tx.conexionDB.update).not.toHaveBeenCalled();
    });
  });

  it('elimina y audita solo metadatos', async () => {
    tx.conexionDB.findFirst.mockResolvedValue({ id: 'connection-1', tipoMotor: 'POSTGRESQL', dbName: 'analytics' });
    const result = await service.remove(admin, 'connection-1');
    expect(result).not.toHaveProperty('connectionStringEncriptada');
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'CONNECTION_DELETED', details: { tipoMotor: 'POSTGRESQL', dbName: 'analytics' } }),
      tx,
    );
  });

  it('lista y lee solo el workspace autenticado e indica el formato de credenciales', async () => {
    prismaService.conexionDB.findMany.mockResolvedValue([savedRow(), savedRow({ id: 'old', credencialesVersion: 1, detalles: null })]);
    const list = await service.findAll(admin);
    expect(prismaService.conexionDB.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 'workspace-1' });
    expect(list.map((c) => c.formatoCredenciales)).toEqual(['ESTRUCTURADO', 'LEGADO']);
    expect(list[0]).not.toHaveProperty('connectionStringEncriptada');

    prismaService.conexionDB.findFirst.mockResolvedValue(null);
    await expect(service.findOne(admin, 'ajena')).rejects.toThrow(NotFoundException);
    expect(prismaService.conexionDB.findFirst.mock.calls[0][0].where).toEqual({ id: 'ajena', workspaceId: 'workspace-1' });
  });

  describe('getConnectionForExploration', () => {
    it('convierte credenciales estructuradas al formato del driver', async () => {
      prismaService.conexionDB.findFirst.mockResolvedValue({
        id: 'connection-1',
        tipoMotor: 'POSTGRESQL',
        dbName: 'analytics',
        connectionStringEncriptada: `encrypted_${serializeCredentials('POSTGRESQL', { ...pgCredentials, port: 5432, ssl: true })}`,
      });
      const result = await service.getConnectionForExploration('connection-1', 'workspace-1');
      expect(result.connectionString).toBe('postgresql://lector_bi:S3creta%232026@db.internal:5432/analytics?sslmode=require');
    });

    it('devuelve tal cual las cadenas legado', async () => {
      prismaService.conexionDB.findFirst.mockResolvedValue({
        id: 'connection-1',
        tipoMotor: 'POSTGRESQL',
        dbName: 'analytics',
        connectionStringEncriptada: 'encrypted_postgres://u:p@db/analytics',
      });
      const result = await service.getConnectionForExploration('connection-1', 'workspace-1');
      expect(result).toEqual({
        id: 'connection-1',
        tipoMotor: 'POSTGRESQL',
        dbName: 'analytics',
        connectionString: 'postgres://u:p@db/analytics',
      });
      expect(prismaService.conexionDB.findFirst.mock.calls[0][0].where).toEqual({
        id: 'connection-1',
        workspaceId: 'workspace-1',
      });
    });
  });
});
