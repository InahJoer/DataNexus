import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EncryptionService } from '../common/encryption/encryption.service.js';
import { PostgresDataExplorer } from '../data-engine/adapters/postgres-data-explorer.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { ConnectionsService } from './connections.service.js';

/**
 * Credenciales estructuradas contra PostgreSQL real (RF-08/RF-09): cifrado AES real, metadatos sin secretos,
 * compatibilidad con conexiones legado y una conexión real del explorador con las credenciales guardadas.
 * Requiere DATABASE_URL con migraciones aplicadas (se ejecuta en CI).
 */
describe.skipIf(!process.env.DATABASE_URL)('Credenciales estructuradas en PostgreSQL', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const encryption = new EncryptionService({
    get: () => process.env.ENCRYPTION_KEY ?? 'a'.repeat(64),
  } as unknown as ConfigService);
  const connections = new ConnectionsService(prisma, encryption, audit);

  const marker = `credenciales-${Date.now()}`;
  const target = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost');
  let admin: AuthenticatedUser;

  beforeAll(async () => {
    await prisma.$connect();
    const workspace = await prisma.workspace.create({ data: { nombreEmpresa: marker } });
    admin = { id: 'admin-test', email: `admin@${marker}.test`, name: 'Admin', role: 'ADMIN', workspaceId: workspace.id };
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { nombreEmpresa: marker } });
    await prisma.$disconnect();
  });

  it('guarda cifrado el payload completo y solo metadatos en claro', async () => {
    const created = await connections.create(admin, {
      tipoMotor: 'POSTGRESQL',
      credenciales: { host: 'db.internal', database: 'ventas', username: 'lector', password: 'Muy$ecreta-2026' },
    });

    const row = await prisma.conexionDB.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.credencialesVersion).toBe(2);
    expect(row.connectionStringEncriptada).not.toContain('Muy$ecreta');
    expect(row.detalles).toEqual({ puerto: 5432, usuario: 'lector', ssl: false });
    expect(JSON.parse(encryption.decrypt(row.connectionStringEncriptada))).toMatchObject({
      v: 2,
      tipoMotor: 'POSTGRESQL',
      credentials: { password: 'Muy$ecreta-2026' },
    });

    const listed = await connections.findAll(admin);
    expect(JSON.stringify(listed)).not.toContain('Muy$ecreta');
    expect(listed.find((c) => c.id === created.id)?.formatoCredenciales).toBe('ESTRUCTURADO');
  });

  it('las conexiones legado siguen funcionando y se marcan como LEGADO', async () => {
    const legacy = await prisma.conexionDB.create({
      data: {
        tipoMotor: 'POSTGRESQL',
        host: 'db.legacy',
        dbName: 'antigua',
        connectionStringEncriptada: encryption.encrypt('postgres://u:p@db.legacy/antigua'),
        workspaceId: admin.workspaceId,
      },
    });

    expect((await connections.findOne(admin, legacy.id)).formatoCredenciales).toBe('LEGADO');
    expect((await connections.getConnectionForExploration(legacy.id, admin.workspaceId)).connectionString).toBe(
      'postgres://u:p@db.legacy/antigua',
    );

    await connections.update(admin, legacy.id, {
      credenciales: { host: 'db.legacy', database: 'antigua', username: 'u', password: 'nueva' },
    });
    expect((await connections.findOne(admin, legacy.id)).formatoCredenciales).toBe('ESTRUCTURADO');
  });

  it('rotar la contraseña conserva el resto y el explorador se conecta con las credenciales guardadas', async () => {
    const created = await connections.create(admin, {
      tipoMotor: 'POSTGRESQL',
      credenciales: {
        host: target.hostname,
        port: Number(target.port || 5432),
        database: target.pathname.slice(1),
        username: decodeURIComponent(target.username),
        password: 'incorrecta',
      },
    });
    await connections.update(admin, created.id, { credenciales: { password: decodeURIComponent(target.password) } });

    const resolved = await connections.getConnectionForExploration(created.id, admin.workspaceId);
    const explorer = new PostgresDataExplorer();
    try {
      const objects = await explorer.listObjects(resolved.connectionString, resolved.dbName);
      expect(objects.some((object) => object.name === 'ConexionDB')).toBe(true);
    } finally {
      await explorer.close();
    }
  });
});
