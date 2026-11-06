import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from './auth.service.js';
import { SessionsService } from './sessions.service.js';
import { AccountLockedException } from './login-lockout.js';

/** Bloqueo por intentos fallidos contra PostgreSQL real (requiere DATABASE_URL con migraciones aplicadas). */
describe.skipIf(!process.env.DATABASE_URL)('Bloqueo de cuenta tras intentos fallidos', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const sessions = new SessionsService(
    prisma,
    new JwtService({ secret: 'x'.repeat(40), signOptions: { expiresIn: '15m' } }),
    audit,
    { get: () => undefined } as unknown as ConfigService,
  );
  const auth = new AuthService(prisma, sessions, audit);
  const marker = `bloqueo-${Date.now()}`;
  const email = `${marker}@empresa.test`;
  const password = 'Correcta#2026x';
  let userId = '';

  const login = (pwd: string) => auth.login({ email, password: pwd });

  beforeAll(async () => {
    await prisma.$connect();
    const workspace = await prisma.workspace.create({ data: { nombreEmpresa: marker } });
    const user = await prisma.user.create({
      data: { email, name: 'Bloqueo', password: await bcrypt.hash(password, 4), workspaceId: workspace.id },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { nombreEmpresa: marker } });
    await prisma.$disconnect();
  });

  it('cuenta los intentos fallidos y un login correcto los reinicia', async () => {
    await expect(login('Mala#2026xx')).rejects.toThrow(UnauthorizedException);
    await expect(login('Mala#2026xx')).rejects.toThrow(UnauthorizedException);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).failedLoginAttempts).toBe(2);

    await expect(login(password)).resolves.toHaveProperty('access_token');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).failedLoginAttempts).toBe(0);
  });

  it('el 5.º intento fallido bloquea la cuenta 15 minutos con 423', async () => {
    for (let i = 0; i < 4; i++) await expect(login('Mala#2026xx')).rejects.toThrow(UnauthorizedException);

    const fifth = await login('Mala#2026xx').catch((error: unknown) => error);
    expect(fifth).toBeInstanceOf(AccountLockedException);
    expect((fifth as AccountLockedException).getStatus()).toBe(HttpStatus.LOCKED);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const minutes = ((user.lockedUntil?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    const locked = await prisma.registroAuditoria.findFirst({ where: { eventType: 'ACCOUNT_LOCKED', targetId: userId } });
    expect(locked?.detailsJson).toContain('"intentos":5');
  });

  it('mientras está bloqueada rechaza incluso la contraseña correcta', async () => {
    await expect(login(password)).rejects.toBeInstanceOf(AccountLockedException);
  });

  it('al vencer el bloqueo se puede entrar de nuevo', async () => {
    await prisma.user.update({ where: { id: userId }, data: { lockedUntil: new Date(Date.now() - 1000) } });

    await expect(login(password)).resolves.toHaveProperty('access_token');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.lockedUntil).toBeNull();
    expect(user.failedLoginAttempts).toBe(0);
  });
});
