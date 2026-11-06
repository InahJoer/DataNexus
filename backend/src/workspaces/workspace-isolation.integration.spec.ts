import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../users/users.service.js';
import { ConnectionsService } from '../connections/connections.service.js';
import type { EncryptionService } from '../common/encryption/encryption.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import type { UserRole } from '../auth/interfaces/user-role.js';
import { WorkspacesService } from './workspaces.service.js';

/**
 * Aislamiento multi-tenant (RF-05) contra PostgreSQL real: un usuario nunca ve ni modifica datos de
 * otro workspace. Requiere DATABASE_URL con migraciones aplicadas (se ejecuta en CI).
 */
describe.skipIf(!process.env.DATABASE_URL)('Aislamiento entre workspaces', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const workspaces = new WorkspacesService(prisma, audit);
  const users = new UsersService(prisma, audit);
  const connections = new ConnectionsService(prisma, {} as EncryptionService, audit);

  const marker = `aislamiento-${Date.now()}`;
  const tenants = {} as Record<'a' | 'b', { workspaceId: string; admin: AuthenticatedUser; connectionId: string }>;
  const asRole = (tenant: 'a' | 'b', role: UserRole): AuthenticatedUser => ({ ...tenants[tenant].admin, role });

  beforeAll(async () => {
    await prisma.$connect();
    for (const key of ['a', 'b'] as const) {
      const workspace = await prisma.workspace.create({
        data: { nombreEmpresa: `${marker}-${key}`, dominiosPermitidos: [`${key}.${marker}.test`] },
      });
      const admin = await prisma.user.create({
        data: {
          email: `admin@${key}.${marker}.test`,
          name: `Admin ${key}`,
          password: 'hash-no-usado',
          role: 'ADMIN',
          workspaceId: workspace.id,
        },
      });
      await prisma.user.create({
        data: {
          email: `lector@${key}.${marker}.test`,
          name: `Lector ${key}`,
          password: 'hash-no-usado',
          role: 'LECTOR',
          workspaceId: workspace.id,
        },
      });
      const connection = await prisma.conexionDB.create({
        data: {
          tipoMotor: key === 'a' ? 'POSTGRESQL' : 'MYSQL',
          host: 'localhost',
          dbName: `db_${key}`,
          connectionStringEncriptada: 'no-usado',
          workspaceId: workspace.id,
        },
      });
      tenants[key] = {
        workspaceId: workspace.id,
        admin: { id: admin.id, email: admin.email, name: admin.name, role: 'ADMIN', workspaceId: workspace.id },
        connectionId: connection.id,
      };
    }
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { nombreEmpresa: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it('GET /workspaces/me devuelve únicamente el workspace propio', async () => {
    const mine = await workspaces.findMine(tenants.a.admin);
    expect(mine.id).toBe(tenants.a.workspaceId);
    expect(mine.configuracion?.dominiosPermitidos).toEqual([`a.${marker}.test`]);
  });

  it('las estadísticas solo cuentan datos del workspace propio', async () => {
    const stats = await workspaces.getStats(asRole('a', 'LECTOR'));
    expect(stats.miembros).toEqual({ total: 2, porRol: { ADMIN: 1, OPERADOR: 0, LECTOR: 1, AUDITOR: 0 } });
    expect(stats.conexiones.total).toBe(1);
    expect(stats.conexiones.porMotor.POSTGRESQL).toBe(1);
    expect(stats.conexiones.porMotor.MYSQL).toBe(0);
  });

  it('PATCH /workspaces/me modifica solo el workspace propio y queda auditado', async () => {
    await workspaces.updateMine(tenants.a.admin, { nombreEmpresa: `${marker}-a-renombrado`, zonaHoraria: 'America/Managua' });

    const [a, b] = await Promise.all([
      prisma.workspace.findUniqueOrThrow({ where: { id: tenants.a.workspaceId } }),
      prisma.workspace.findUniqueOrThrow({ where: { id: tenants.b.workspaceId } }),
    ]);
    expect(a.nombreEmpresa).toBe(`${marker}-a-renombrado`);
    expect(a.zonaHoraria).toBe('America/Managua');
    expect(b.nombreEmpresa).toBe(`${marker}-b`);
    expect(b.zonaHoraria).toBe('UTC');

    const log = await prisma.registroAuditoria.findFirst({
      where: { eventType: 'WORKSPACE_UPDATED', workspaceId: tenants.a.workspaceId },
    });
    expect(log?.detailsJson).toContain('America/Managua');
    expect(
      await prisma.registroAuditoria.count({ where: { eventType: 'WORKSPACE_UPDATED', workspaceId: tenants.b.workspaceId } }),
    ).toBe(0);
  });

  it('la lista de miembros no incluye usuarios de otro workspace', async () => {
    const members = await users.findAll(tenants.a.admin);
    expect(members).toHaveLength(2);
    expect(members.every((member) => member.workspaceId === tenants.a.workspaceId)).toBe(true);
  });

  it('un ADMIN no puede cambiar el rol de un usuario de otro workspace', async () => {
    await expect(users.updateRole(tenants.a.admin, tenants.b.admin.id, 'LECTOR')).rejects.toThrow(NotFoundException);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: tenants.b.admin.id } })).role).toBe('ADMIN');
  });

  it('no se puede invitar con un correo fuera de los dominios permitidos del workspace', async () => {
    await expect(
      users.inviteMember(tenants.a.admin, { email: `nuevo@b.${marker}.test`, name: 'Nuevo', role: 'LECTOR' }),
    ).rejects.toThrow(/dominio permitido/);
  });

  it('las conexiones de otro workspace no se listan, no se leen y no se borran', async () => {
    const list = await connections.findAll(tenants.a.admin);
    expect(list.map((connection) => connection.id)).toEqual([tenants.a.connectionId]);

    await expect(connections.findOne(tenants.a.admin, tenants.b.connectionId)).rejects.toThrow(NotFoundException);
    await expect(connections.remove(tenants.a.admin, tenants.b.connectionId)).rejects.toThrow(NotFoundException);
    expect(await prisma.conexionDB.count({ where: { id: tenants.b.connectionId } })).toBe(1);
  });

  it('la bitácora de auditoría solo muestra eventos del workspace propio', async () => {
    const page = await audit.findAll(asRole('b', 'AUDITOR'), { page: 1, limit: 100 });
    expect(page.data.every((log) => log.workspaceId === tenants.b.workspaceId)).toBe(true);
    expect(page.data.some((log) => log.eventType === 'WORKSPACE_UPDATED')).toBe(false);
  });
});
