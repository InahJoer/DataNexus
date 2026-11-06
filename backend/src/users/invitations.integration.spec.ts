import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import type { MailService } from '../mailer/mail.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { InvitationsService } from './invitations.service.js';
import { UsersService } from './users.service.js';

/**
 * Flujo completo de invitaciones y bajas (RF-06) contra PostgreSQL real.
 * Requiere DATABASE_URL con migraciones aplicadas (se ejecuta en CI).
 */
describe.skipIf(!process.env.DATABASE_URL)('Invitaciones y baja de miembros', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const config = { get: () => undefined } as unknown as ConfigService;
  const sessions = new SessionsService(
    prisma,
    new JwtService({ secret: 'x'.repeat(40), signOptions: { expiresIn: '15m' } }),
    audit,
    config,
  );
  const auth = new AuthService(prisma, sessions, audit);
  const outbox: { to: string; text: string }[] = [];
  const mail = {
    sendMail: (message: { to: string; text: string }) => {
      outbox.push(message);
      return Promise.resolve({ messageId: `m-${outbox.length}` });
    },
  } as unknown as MailService;
  const invitations = new InvitationsService(prisma, audit, mail, config);
  const users = new UsersService(prisma, audit);

  const marker = `invitaciones-${Date.now()}`;
  const domain = `${marker}.test`;
  const password = 'MiClave#2026dn';
  let adminA: AuthenticatedUser;
  let adminA2: AuthenticatedUser;
  let adminB: AuthenticatedUser;

  const lastToken = (to: string): string => {
    const message = [...outbox].reverse().find((m) => m.to === to);
    const token = /accept-invite\?token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '')?.[1];
    if (!token) throw new Error(`No hay correo de invitación para ${to}`);
    return token;
  };

  const createAdmin = async (workspaceId: string, email: string): Promise<AuthenticatedUser> => {
    const user = await prisma.user.create({
      data: { email, name: email, password: await bcrypt.hash(password, 4), role: 'ADMIN', workspaceId },
    });
    return { id: user.id, email: user.email, name: user.name, role: 'ADMIN', workspaceId };
  };

  beforeAll(async () => {
    await prisma.$connect();
    const a = await prisma.workspace.create({ data: { nombreEmpresa: `${marker}-a` } });
    const b = await prisma.workspace.create({ data: { nombreEmpresa: `${marker}-b` } });
    adminA = await createAdmin(a.id, `admin-a@${domain}`);
    adminA2 = await createAdmin(a.id, `admin-a2@${domain}`);
    adminB = await createAdmin(b.id, `admin-b@${domain}`);
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { nombreEmpresa: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it('invitar → consultar → aceptar crea la cuenta con el rol indicado y permite iniciar sesión', async () => {
    const email = `ana@${domain}`;
    const created = await invitations.invite(adminA, { email, name: 'Ana', role: 'OPERADOR' });
    expect(created).toMatchObject({ estado: 'PENDIENTE', correoEnviado: true });
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    const token = lastToken(email);
    await expect(invitations.preview(token)).resolves.toMatchObject({
      email,
      role: 'OPERADOR',
      nombreEmpresa: `${marker}-a`,
    });

    await invitations.accept({ token, password, name: 'Ana Pérez' });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ name: 'Ana Pérez', role: 'OPERADOR', workspaceId: adminA.workspaceId });
    await expect(auth.login({ email, password })).resolves.toHaveProperty('access_token');

    const stored = await prisma.invitation.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.status).toBe('ACEPTADA');
    expect(stored.tokenHash).not.toBe(token);
  });

  it('el enlace es de un solo uso', async () => {
    const email = `doble@${domain}`;
    await invitations.invite(adminA, { email, name: 'Doble', role: 'LECTOR' });
    const token = lastToken(email);

    await invitations.accept({ token, password });
    await expect(invitations.accept({ token, password })).rejects.toThrow(BadRequestException);
  });

  it('dos aceptaciones simultáneas del mismo enlace crean una sola cuenta', async () => {
    const email = `carrera@${domain}`;
    await invitations.invite(adminA, { email, name: 'Carrera', role: 'LECTOR' });
    const token = lastToken(email);

    const results = await Promise.allSettled([
      invitations.accept({ token, password }),
      invitations.accept({ token, password }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('una invitación expirada no puede usarse y se lista como EXPIRADA', async () => {
    const email = `vencida@${domain}`;
    const created = await invitations.invite(adminA, { email, name: 'Vencida', role: 'LECTOR' });
    await prisma.invitation.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(invitations.accept({ token: lastToken(email), password })).rejects.toThrow(BadRequestException);
    const expired = await invitations.list(adminA, 'EXPIRADA');
    expect(expired.map((i) => i.id)).toContain(created.id);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('reenviar invalida el enlace anterior y reactiva una invitación expirada', async () => {
    const email = `reenvio@${domain}`;
    const created = await invitations.invite(adminA, { email, name: 'Reenvío', role: 'LECTOR' });
    const oldToken = lastToken(email);
    await prisma.invitation.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await invitations.resend(adminA, created.id);
    const newToken = lastToken(email);
    expect(newToken).not.toBe(oldToken);

    await expect(invitations.accept({ token: oldToken, password })).rejects.toThrow(BadRequestException);
    await invitations.accept({ token: newToken, password });
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('una invitación revocada no puede usarse ni reenviarse', async () => {
    const email = `revocada@${domain}`;
    const created = await invitations.invite(adminA, { email, name: 'Revocada', role: 'LECTOR' });

    await expect(invitations.revoke(adminA, created.id)).resolves.toMatchObject({ estado: 'REVOCADA' });
    await expect(invitations.accept({ token: lastToken(email), password })).rejects.toThrow(BadRequestException);
    await expect(invitations.resend(adminA, created.id)).rejects.toThrow(ConflictException);
  });

  it('un ADMIN no puede ver, reenviar ni revocar invitaciones de otro workspace', async () => {
    const created = await invitations.invite(adminA, { email: `ajena@${domain}`, name: 'Ajena', role: 'LECTOR' });

    expect((await invitations.list(adminB)).map((i) => i.id)).not.toContain(created.id);
    await expect(invitations.resend(adminB, created.id)).rejects.toThrow(NotFoundException);
    await expect(invitations.revoke(adminB, created.id)).rejects.toThrow(NotFoundException);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('PENDIENTE');
  });

  it('dar de baja a un miembro elimina su cuenta y cierra sus sesiones', async () => {
    const email = `baja@${domain}`;
    await invitations.invite(adminA, { email, name: 'Baja', role: 'LECTOR' });
    await invitations.accept({ token: lastToken(email), password });
    await auth.login({ email, password });
    const member = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await prisma.userSession.count({ where: { userId: member.id } })).toBe(1);

    await users.removeMember(adminA, member.id);

    expect(await prisma.user.count({ where: { id: member.id } })).toBe(0);
    expect(await prisma.userSession.count({ where: { userId: member.id } })).toBe(0);
    const log = await prisma.registroAuditoria.findFirst({ where: { eventType: 'USER_REMOVED', targetId: member.id } });
    expect(log?.detailsJson).toContain(email);
  });

  it('un ADMIN de otro workspace no puede dar de baja miembros ajenos', async () => {
    await expect(users.removeMember(adminB, adminA2.id)).rejects.toThrow(NotFoundException);
  });

  it('nadie puede darse de baja a sí mismo', async () => {
    await expect(users.removeMember(adminB, adminB.id)).rejects.toThrow(ForbiddenException);
  });

  it('si dos ADMIN se dan de baja mutuamente a la vez, el workspace conserva un ADMINISTRADOR', async () => {
    const results = await Promise.allSettled([
      users.removeMember(adminA, adminA2.id),
      users.removeMember(adminA2, adminA.id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.user.count({ where: { workspaceId: adminA.workspaceId, role: 'ADMIN' } })).toBe(1);
  });

  it('las invitaciones de un ADMIN dado de baja se conservan sin autor', async () => {
    const remainingAdmin = await prisma.user.findFirstOrThrow({
      where: { workspaceId: adminA.workspaceId, role: 'ADMIN' },
    });
    const survivor = remainingAdmin.id === adminA.id ? adminA : adminA2;
    const removedId = survivor.id === adminA.id ? adminA2.id : adminA.id;

    const orphaned = await prisma.invitation.count({ where: { workspaceId: adminA.workspaceId, invitedById: null } });
    const fromRemoved = await prisma.invitation.count({ where: { invitedById: removedId } });
    expect(fromRemoved).toBe(0);
    if (removedId === adminA.id) expect(orphaned).toBeGreaterThan(0);

    // El último ADMIN no puede perder el rol ni ser dado de baja por nadie del workspace.
    await expect(users.updateRole(survivor, survivor.id, 'LECTOR')).rejects.toThrow(ForbiddenException);
  });
});
