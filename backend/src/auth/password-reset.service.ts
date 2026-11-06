import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mailer/mail.service.js';
import { renderPasswordResetEmail } from '../mailer/templates/password-reset.template.js';
import type { RequestAuditContext } from './interfaces/authenticated-user.interface.js';
import { SessionsService } from './sessions.service.js';

export const DEFAULT_RESET_TTL_MINUTES = 30;

/** Respuesta idéntica exista o no el correo, para no revelar qué cuentas existen. */
export const FORGOT_PASSWORD_MESSAGE =
  'Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.';

export const INVALID_RESET_TOKEN_MESSAGE =
  'El enlace de recuperación es inválido o ya expiró. Solicita uno nuevo.';

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Recuperación de contraseña por correo (RF-03).
 * - El token es aleatorio (256 bits) y en la base solo se guarda su hash SHA-256.
 * - Vence a los PASSWORD_RESET_TTL_MINUTES (30 por defecto) y es de un solo uso.
 * - Pedir un enlace nuevo invalida los anteriores del mismo usuario.
 * - Restablecer la contraseña cierra todas las sesiones abiertas del usuario.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly sessionsService: SessionsService,
  ) {}

  private get ttlMinutes(): number {
    const value = Number(this.configService.get('PASSWORD_RESET_TTL_MINUTES'));
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_RESET_TTL_MINUTES;
  }

  private get frontendUrl(): string {
    return (this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  async requestReset(email: string, context: RequestAuditContext = {}): Promise<{ message: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, name: true, workspaceId: true },
    });

    if (!user) {
      await this.auditService.record({
        eventType: 'PASSWORD_RESET_REQUESTED',
        outcome: 'FAILURE',
        actorEmail: normalizedEmail,
        details: { motivo: 'usuario_no_encontrado' },
        ...context,
      });
      return { message: FORGOT_PASSWORD_MESSAGE };
    }

    const token = randomBytes(32).toString('base64url');
    const ttl = this.ttlMinutes;

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(Date.now() + ttl * 60_000),
        },
      }),
    ]);

    await this.auditService.record({
      eventType: 'PASSWORD_RESET_REQUESTED',
      outcome: 'SUCCESS',
      actorUserId: user.id,
      actorEmail: user.email,
      workspaceId: user.workspaceId,
      targetType: 'USER',
      targetId: user.id,
      ...context,
    });

    const resetUrl = `${this.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const email$ = renderPasswordResetEmail({ name: user.name, resetUrl, expiresInMinutes: ttl });

    // No se espera el envío: así el tiempo de respuesta no revela si el correo existe.
    void this.mailService
      .sendMail({ to: user.email, ...email$ })
      .catch((error: unknown) =>
        this.logger.error(
          `No se pudo enviar el correo de recuperación al usuario ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  async resetPassword(
    token: string,
    newPassword: string,
    context: RequestAuditContext = {},
  ): Promise<{ message: string }> {
    const tokenHash = hashResetToken(token);
    const passwordHash = await bcrypt.hash(newPassword, 10);

    const user = await this.prisma.$transaction(async (tx) => {
      const record = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, expiresAt: true, usedAt: true },
      });
      if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) return null;

      // Consumo atómico: si dos peticiones usan el mismo token a la vez, solo una gana.
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) return null;

      const updated = await tx.user.update({
        where: { id: record.userId },
        // Restablecer la contraseña también desbloquea la cuenta.
        data: { password: passwordHash, failedLoginAttempts: 0, lockedUntil: null },
        select: { id: true, email: true, workspaceId: true },
      });
      await tx.passwordResetToken.deleteMany({ where: { userId: record.userId, usedAt: null } });
      // Cambiar la contraseña cierra todas las sesiones abiertas del usuario.
      await this.sessionsService.revokeAllForUser(record.userId, 'cambio_contrasena', tx);

      await this.auditService.record(
        {
          eventType: 'PASSWORD_RESET',
          outcome: 'SUCCESS',
          actorUserId: updated.id,
          actorEmail: updated.email,
          workspaceId: updated.workspaceId,
          targetType: 'USER',
          targetId: updated.id,
          ...context,
        },
        tx,
      );
      return updated;
    });

    if (!user) {
      await this.auditService.record({
        eventType: 'PASSWORD_RESET',
        outcome: 'FAILURE',
        details: { motivo: 'token_invalido_o_expirado' },
        ...context,
      });
      throw new BadRequestException(INVALID_RESET_TOKEN_MESSAGE);
    }

    return { message: 'Tu contraseña se actualizó. Ya puedes iniciar sesión.' };
  }
}
