import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from './sessions.service.js';
import { AuthService } from './auth.service.js';
import { SignupDto } from './dto/signup.dto.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface.js';

const PASSWORD = 'Registro#2026dn';

/** Validación del DTO de alta (sin base de datos). */
describe('SignupDto', () => {
  const errorsOf = async (input: Record<string, unknown>) =>
    (await validate(plainToInstance(SignupDto, input))).map((error) => error.property);

  it('una cuenta personal admite cualquier correo y no pide organización', async () => {
    expect(await errorsOf({ tipoCuenta: 'PERSONAL', name: 'Ana', email: 'ana@gmail.com', password: PASSWORD })).toEqual([]);
  });

  it('una organización exige correo corporativo y nombre de la organización', async () => {
    expect(await errorsOf({ tipoCuenta: 'ORGANIZACION', name: 'Ana', email: 'ana@gmail.com', password: PASSWORD })).toEqual(
      expect.arrayContaining(['email', 'nombreEmpresa']),
    );
    expect(
      await errorsOf({ tipoCuenta: 'ORGANIZACION', name: 'Ana', email: 'ana@acme.com', password: PASSWORD, nombreEmpresa: 'Acme' }),
    ).toEqual([]);
  });

  it('rechaza un tipo de cuenta desconocido y contraseñas débiles', async () => {
    expect(await errorsOf({ tipoCuenta: 'EMPRESA', name: 'Ana', email: 'ana@acme.com', password: 'corta' })).toEqual(
      expect.arrayContaining(['tipoCuenta', 'password']),
    );
  });
});

/** Alta de cuentas contra PostgreSQL real (requiere DATABASE_URL con migraciones aplicadas). */
describe.skipIf(!process.env.DATABASE_URL)('AuthService.signup en PostgreSQL', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const jwt = new JwtService({ secret: 'x'.repeat(40), signOptions: { expiresIn: '15m' } });
  const sessions = new SessionsService(prisma, jwt, audit, { get: () => undefined } as unknown as ConfigService);
  const auth = new AuthService(prisma, sessions, audit);
  const workspaces = new WorkspacesService(prisma, audit);
  const marker = `signup${Date.now()}`;
  const emails = [`${marker}@gmail.com`, `${marker}@${marker}.io`];

  beforeAll(() => prisma.$connect());
  afterAll(async () => {
    const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { workspaceId: true } });
    await prisma.workspace.deleteMany({ where: { id: { in: users.map((user) => user.workspaceId) } } });
    await prisma.$disconnect();
  });

  it('una cuenta personal crea su espacio, la deja como ADMIN e inicia sesión', async () => {
    const result = await auth.signup({ tipoCuenta: 'PERSONAL', name: 'Ana López', email: emails[0], password: PASSWORD, zonaHoraria: 'America/Managua' });
    expect(result.access_token).toBeTruthy();
    expect(result.user).toMatchObject({ email: emails[0], role: 'ADMIN' });
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: result.user.workspaceId } });
    expect(workspace).toMatchObject({ tipoCuenta: 'PERSONAL', nombreEmpresa: 'Espacio de Ana', zonaHoraria: 'America/Managua', dominiosPermitidos: [] });
    const event = await prisma.registroAuditoria.findFirst({ where: { workspaceId: workspace.id, eventType: 'ACCOUNT_CREATED' } });
    expect(event).not.toBeNull();
  });

  it('una organización deja su dominio como permitido para invitar al equipo', async () => {
    const result = await auth.signup({ tipoCuenta: 'ORGANIZACION', name: 'Luis', email: emails[1], password: PASSWORD, nombreEmpresa: 'Acme S.A.' });
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: result.user.workspaceId } });
    expect(workspace).toMatchObject({ tipoCuenta: 'ORGANIZACION', nombreEmpresa: 'Acme S.A.', dominiosPermitidos: [`${marker}.io`], zonaHoraria: 'UTC' });
  });

  it('no permite dos cuentas con el mismo correo', async () => {
    await expect(auth.signup({ tipoCuenta: 'PERSONAL', name: 'Otra', email: emails[0], password: PASSWORD })).rejects.toBeInstanceOf(ConflictException);
  });

  it('un espacio personal se puede convertir en organización, pero no al revés', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: emails[0] } });
    const actor = { id: user.id, email: user.email, name: user.name, role: 'ADMIN', workspaceId: user.workspaceId } as AuthenticatedUser;
    const updated = await workspaces.updateMine(actor, { tipoCuenta: 'ORGANIZACION', descripcion: '  Mis análisis  ' } as never);
    expect(updated).toMatchObject({ tipoCuenta: 'ORGANIZACION', descripcion: 'Mis análisis' });
  });
});
