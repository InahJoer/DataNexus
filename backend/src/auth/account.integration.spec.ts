import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from './sessions.service.js';
import { AccountService } from './account.service.js';
import { UsersService } from '../users/users.service.js';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface.js';

const PASSWORD = 'Actual#2026dn';

/** Perfil, contraseña y sesiones (#64) contra PostgreSQL real. */
describe.skipIf(!process.env.DATABASE_URL)('Cuenta propia y sesiones (#64)', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const jwt = new JwtService({ secret: 'x'.repeat(40), signOptions: { expiresIn: '15m' } });
  const sessions = new SessionsService(prisma, jwt, audit, { get: () => undefined } as unknown as ConfigService);
  const account = new AccountService(prisma, audit);
  const users = new UsersService(prisma, audit);
  const marker = `cuenta${Date.now()}`;
  let admin: AuthenticatedUser;
  let lector: AuthenticatedUser;
  const sidOf = (token: string) => jwt.decode<{ sid: string }>(token).sid;
  const active = (userId: string) => prisma.userSession.count({ where: { userId, revokedAt: null } });

  beforeAll(async () => {
    await prisma.$connect();
    const workspace = await prisma.workspace.create({ data: { nombreEmpresa: marker } });
    const hash = await bcrypt.hash(PASSWORD, 4);
    const make = async (role: 'ADMIN' | 'LECTOR') => {
      const user = await prisma.user.create({ data: { email: `${role.toLowerCase()}@${marker}.io`, name: role, password: hash, role, workspaceId: workspace.id } });
      return { id: user.id, email: user.email, name: user.name, role, workspaceId: workspace.id } as AuthenticatedUser;
    };
    admin = await make('ADMIN');
    lector = await make('LECTOR');
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { nombreEmpresa: marker } });
    await prisma.$disconnect();
  });

  it('edita el nombre y lo registra en la bitácora con el antes y el después', async () => {
    await expect(account.updateProfile(lector, { name: '  Lucía   Pérez ' })).resolves.toMatchObject({ name: 'Lucía Pérez', email: lector.email });
    const event = await prisma.registroAuditoria.findFirst({ where: { actorUserId: lector.id, eventType: 'PROFILE_UPDATED' } });
    expect(JSON.parse(event?.detailsJson ?? '{}')).toMatchObject({ cambios: { name: { antes: 'LECTOR', despues: 'Lucía Pérez' } } });
  });

  it('cambia la contraseña con la actual, rechaza la incorrecta o repetida y cierra las demás sesiones', async () => {
    const current = await sessions.startSession(lector);
    await sessions.startSession(lector);
    const actor = { ...lector, sessionId: sidOf(current.access_token) };

    await expect(account.changePassword(actor, { currentPassword: 'otra', newPassword: 'Nueva#2026dn' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(account.changePassword(actor, { currentPassword: PASSWORD, newPassword: PASSWORD })).rejects.toBeInstanceOf(BadRequestException);
    await expect(account.changePassword(actor, { currentPassword: PASSWORD, newPassword: 'Nueva#2026dn' })).resolves.toMatchObject({ sesionesCerradas: 1 });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: lector.id } });
    expect(await bcrypt.compare('Nueva#2026dn', user.password)).toBe(true);
    // Solo queda la sesión desde la que se cambió.
    expect(await active(lector.id)).toBe(1);
  });

  it('lista mis sesiones marcando la actual y solo me deja cerrar las mías', async () => {
    const mine = await sessions.startSession(admin);
    const other = await sessions.startSession(admin, { ipAddress: '192.0.2.20' });
    const actor = { ...admin, sessionId: sidOf(mine.access_token) };
    const list = await account.listSessions(actor);
    expect(list.find((session) => session.actual)?.id).toBe(sidOf(mine.access_token));
    await expect(account.revokeSession(actor, sidOf(other.access_token))).resolves.toEqual({ revocadas: 1 });
    await expect(account.revokeSession({ ...lector }, sidOf(mine.access_token))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el ADMIN ve último acceso y sesiones de cada miembro y puede cerrarlas', async () => {
    await sessions.startSession(lector);
    const members = await users.findAll(admin);
    const lectorRow = members.find((member) => member.id === lector.id);
    expect(lectorRow?.sesionesActivas).toBeGreaterThanOrEqual(1);
    expect(lectorRow?.ultimoAcceso).toBeInstanceOf(Date);
    await expect(users.revokeUserSessions(lector, admin.id)).rejects.toBeInstanceOf(ForbiddenException);
    await users.revokeUserSessions(admin, lector.id);
    expect(await active(lector.id)).toBe(0);
  });

  it('cerrar todas las sesiones del workspace conserva la del propio ADMIN', async () => {
    const mine = await sessions.startSession(admin);
    await sessions.startSession(lector);
    const actor = { ...admin, sessionId: sidOf(mine.access_token) };
    const result = await users.revokeAllSessions(actor);
    expect(result.revocadas).toBeGreaterThanOrEqual(1);
    expect(await prisma.userSession.count({ where: { user: { workspaceId: admin.workspaceId }, revokedAt: null } })).toBe(1);
    await expect(sessions.assertActive(sidOf(mine.access_token), admin.id)).resolves.toBeUndefined();
  });
});
