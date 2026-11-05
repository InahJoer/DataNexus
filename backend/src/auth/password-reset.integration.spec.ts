import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { MailService } from '../mailer/mail.service.js';
import { PasswordResetService } from './password-reset.service.js';
import type { SessionsService } from './sessions.service.js';

/** Flujo completo contra PostgreSQL real (requiere DATABASE_URL con migraciones aplicadas). */
describe.skipIf(!process.env.DATABASE_URL)('Recuperación de contraseña en PostgreSQL', () => {
  const prisma = new PrismaService();
  const sendMail = vi.fn().mockResolvedValue({ messageId: 'm', accepted: [], rejected: [] });
  const service = new PasswordResetService(
    prisma,
    new AuditService(prisma),
    { sendMail } as unknown as MailService,
    { get: () => undefined } as unknown as ConfigService,
    { revokeAllForUser: vi.fn().mockResolvedValue(0) } as unknown as SessionsService,
  );
  const email = `reset-${Date.now()}@datanexus.test`;
  let userId = '';

  const lastToken = (): string => {
    const text = sendMail.mock.calls.at(-1)?.[0].text as string;
    return /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
  };

  beforeAll(async () => {
    await prisma.$connect();
    const workspace = await prisma.workspace.create({ data: { nombreEmpresa: 'Reset Test' } });
    const user = await prisma.user.create({
      data: { email, name: 'Reset', password: await bcrypt.hash('Anterior2026!', 4), workspaceId: workspace.id },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { nombreEmpresa: 'Reset Test' } });
    await prisma.$disconnect();
  });

  it('un token nuevo invalida al anterior', async () => {
    await service.requestReset(email);
    const first = lastToken();
    await service.requestReset(email);
    const second = lastToken();

    expect(first).not.toBe(second);
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(1);
    await expect(service.resetPassword(first, 'Nueva2026!!')).rejects.toThrow(BadRequestException);
  });

  it('restablece la contraseña una sola vez', async () => {
    const token = lastToken();
    await service.resetPassword(token, 'Nueva2026!!');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await bcrypt.compare('Nueva2026!!', user.password)).toBe(true);
    await expect(service.resetPassword(token, 'OtraMas2026!')).rejects.toThrow(BadRequestException);
  });

  it('dos usos simultáneos del mismo token: solo uno gana', async () => {
    await service.requestReset(email);
    const token = lastToken();

    const results = await Promise.allSettled([
      service.resetPassword(token, 'Carrera1-2026!'),
      service.resetPassword(token, 'Carrera2-2026!'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('un token expirado se rechaza', async () => {
    await service.requestReset(email);
    const token = lastToken();
    await prisma.passwordResetToken.updateMany({ where: { userId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(service.resetPassword(token, 'Expirado2026!')).rejects.toThrow(BadRequestException);
  });
});
