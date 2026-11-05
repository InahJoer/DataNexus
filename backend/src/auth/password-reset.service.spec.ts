import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import bcrypt from 'bcrypt';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { MailService } from '../mailer/mail.service.js';
import {
  FORGOT_PASSWORD_MESSAGE,
  INVALID_RESET_TOKEN_MESSAGE,
  PasswordResetService,
  hashResetToken,
} from './password-reset.service.js';
import { renderPasswordResetEmail } from '../mailer/templates/password-reset.template.js';

const user = { id: 'u1', email: 'ana@corp.com', name: 'Ana', workspaceId: 'ws-1' };

function setup(config: Record<string, unknown> = {}) {
  const tx = {
    passwordResetToken: { findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    user: { update: vi.fn().mockResolvedValue(user) },
  };
  const prisma = {
    user: { findUnique: vi.fn() },
    passwordResetToken: {
      deleteMany: vi.fn().mockReturnValue('delete-op'),
      create: vi.fn().mockReturnValue('create-op'),
    },
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function' ? (arg as (client: typeof tx) => unknown)(tx) : Promise.resolve(arg),
    ),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const mail = { sendMail: vi.fn().mockResolvedValue({ messageId: 'm1', accepted: [], rejected: [] }) };
  const configService = { get: (key: string) => config[key] } as unknown as ConfigService;
  const service = new PasswordResetService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    mail as unknown as MailService,
    configService,
  );
  return { service, prisma, tx, audit, mail };
}

describe('PasswordResetService.requestReset', () => {
  it('devuelve el mismo mensaje y no envía correo si el usuario no existe', async () => {
    const { service, prisma, audit, mail } = setup();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.requestReset('NADIE@corp.com')).resolves.toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'PASSWORD_RESET_REQUESTED', outcome: 'FAILURE', actorEmail: 'nadie@corp.com' }),
    );
  });

  it('guarda solo el hash del token, invalida los anteriores y envía el enlace por correo', async () => {
    const { service, prisma, audit, mail } = setup({ FRONTEND_URL: 'https://app.datanexus.io/', PASSWORD_RESET_TTL_MINUTES: 45 });
    prisma.user.findUnique.mockResolvedValue(user);
    const before = Date.now();

    await expect(service.requestReset('ana@corp.com', { ipAddress: '192.0.2.1' })).resolves.toEqual({
      message: FORGOT_PASSWORD_MESSAGE,
    });

    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    const created = prisma.passwordResetToken.create.mock.calls[0][0].data;
    expect(created.userId).toBe('u1');
    expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.expiresAt.getTime() - before).toBeGreaterThanOrEqual(45 * 60_000 - 1000);
    expect(created.expiresAt.getTime() - before).toBeLessThanOrEqual(45 * 60_000 + 1000);

    const sent = mail.sendMail.mock.calls[0][0];
    expect(sent.to).toBe('ana@corp.com');
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.text)?.[1] ?? '';
    expect(sent.text).toContain('https://app.datanexus.io/reset-password?token=');
    expect(token).toHaveLength(43);
    expect(hashResetToken(token)).toBe(created.tokenHash);
    expect(created.tokenHash).not.toContain(token);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'PASSWORD_RESET_REQUESTED', outcome: 'SUCCESS', targetId: 'u1', ipAddress: '192.0.2.1' }),
    );
  });

  it('si el correo falla, la respuesta sigue siendo la genérica', async () => {
    const { service, prisma, mail } = setup();
    prisma.user.findUnique.mockResolvedValue(user);
    mail.sendMail.mockRejectedValue(new Error('SMTP caído'));

    await expect(service.requestReset('ana@corp.com')).resolves.toEqual({ message: FORGOT_PASSWORD_MESSAGE });
  });
});

describe('PasswordResetService.resetPassword', () => {
  const token = 'a'.repeat(43);

  it('actualiza la contraseña con bcrypt, consume el token y audita', async () => {
    const { service, tx, audit } = setup();
    tx.passwordResetToken.findUnique.mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.resetPassword(token, 'NuevaClave2026!')).resolves.toHaveProperty('message');

    expect(tx.passwordResetToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashResetToken(token) } }),
    );
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    const newHash = tx.user.update.mock.calls[0][0].data.password;
    expect(await bcrypt.compare('NuevaClave2026!', newHash)).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'PASSWORD_RESET', outcome: 'SUCCESS', targetId: 'u1' }),
      tx,
    );
  });

  it.each([
    ['inexistente', null],
    ['ya usado', { id: 't1', userId: 'u1', usedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }],
    ['expirado', { id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() - 1) }],
  ])('rechaza un token %s con 400 sin tocar la contraseña', async (_caso, record) => {
    const { service, tx, audit } = setup();
    tx.passwordResetToken.findUnique.mockResolvedValue(record);

    await expect(service.resetPassword(token, 'NuevaClave2026!')).rejects.toThrow(
      new BadRequestException(INVALID_RESET_TOKEN_MESSAGE),
    );
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'PASSWORD_RESET', outcome: 'FAILURE' }),
    );
  });

  it('si otra petición consumió el token al mismo tiempo, rechaza con 400', async () => {
    const { service, tx } = setup();
    tx.passwordResetToken.findUnique.mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.resetPassword(token, 'NuevaClave2026!')).rejects.toThrow(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe('renderPasswordResetEmail', () => {
  it('escapa el nombre en HTML e incluye el enlace y el vencimiento', () => {
    const email = renderPasswordResetEmail({
      name: '<script>alert(1)</script>',
      resetUrl: 'https://app/reset-password?token=abc',
      expiresInMinutes: 30,
    });
    expect(email.subject).toContain('Restablece');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('href="https://app/reset-password?token=abc"');
    expect(email.text).toContain('30 minutos');
  });
});
