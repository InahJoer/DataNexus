import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser, RequestAuditContext } from './interfaces/authenticated-user.interface.js';
import type { ChangePasswordDto, SessionResponseDto, UpdateProfileDto } from './dto/account.dto.js';
import { getPasswordPolicyErrors } from './validators/password-policy.js';

const ACTIVE_SESSION = (now: Date) => ({ revokedAt: null, expiresAt: { gt: now } });

/**
 * Cuenta propia (#64): datos del perfil, cambio de contraseña y sesiones abiertas del usuario autenticado.
 * Todo se limita al usuario del token; un usuario nunca ve ni cierra sesiones de otro desde aquí.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async updateProfile(actor: AuthenticatedUser, dto: UpdateProfileDto, context: RequestAuditContext = {}) {
    const name = dto.name.trim().replace(/\s+/g, ' ');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id: actor.id }, select: { name: true } });
      if (!before) throw new NotFoundException('Usuario no encontrado');
      const user = await tx.user.update({
        where: { id: actor.id },
        data: { name },
        select: { id: true, email: true, name: true, role: true, workspaceId: true },
      });
      if (before.name !== name) {
        await this.auditService.record(
          {
            eventType: 'PROFILE_UPDATED',
            outcome: 'SUCCESS',
            actorUserId: actor.id,
            actorEmail: actor.email,
            workspaceId: actor.workspaceId,
            targetType: 'USER',
            targetId: actor.id,
            details: { campos: ['name'], cambios: { name: { antes: before.name, despues: name } } },
            ...context,
          },
          tx,
        );
      }
      return user;
    });
  }

  /** Exige la contraseña actual, aplica la política (#22) y cierra las demás sesiones del usuario. */
  async changePassword(actor: AuthenticatedUser, dto: ChangePasswordDto, context: RequestAuditContext = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.id }, select: { password: true, email: true } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (!(await bcrypt.compare(dto.currentPassword, user.password))) {
      await this.auditService.record({
        eventType: 'PASSWORD_CHANGED',
        outcome: 'FAILURE',
        actorUserId: actor.id,
        actorEmail: actor.email,
        workspaceId: actor.workspaceId,
        targetType: 'USER',
        targetId: actor.id,
        details: { motivo: 'contrasena_actual_incorrecta' },
        ...context,
      });
      throw new UnauthorizedException('La contraseña actual no es correcta');
    }
    const errors = getPasswordPolicyErrors(dto.newPassword, user.email);
    if (errors.length) throw new BadRequestException(`La contraseña no cumple la política de seguridad. Debe tener: ${errors.join(', ')}.`);
    if (await bcrypt.compare(dto.newPassword, user.password)) {
      throw new BadRequestException('La nueva contraseña debe ser distinta de la actual');
    }

    const hash = await bcrypt.hash(dto.newPassword, 10);
    const revoked = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: actor.id }, data: { password: hash, failedLoginAttempts: 0, lockedUntil: null } });
      const result = await tx.userSession.updateMany({
        where: { userId: actor.id, revokedAt: null, ...(actor.sessionId ? { id: { not: actor.sessionId } } : {}) },
        data: { revokedAt: new Date(), revokedReason: 'cambio_contrasena' },
      });
      await this.auditService.record(
        {
          eventType: 'PASSWORD_CHANGED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'USER',
          targetId: actor.id,
          details: { sesionesCerradas: result.count },
          ...context,
        },
        tx,
      );
      return result.count;
    });
    return { message: 'Contraseña actualizada. Cerramos tus otras sesiones abiertas.', sesionesCerradas: revoked };
  }

  async listSessions(actor: AuthenticatedUser): Promise<SessionResponseDto[]> {
    const sessions = await this.prisma.userSession.findMany({
      where: { userId: actor.id, ...ACTIVE_SESSION(new Date()) },
      select: { id: true, createdAt: true, lastActivityAt: true, ipAddress: true, userAgent: true },
      orderBy: { lastActivityAt: 'desc' },
    });
    return sessions.map((session) => ({ ...session, actual: session.id === actor.sessionId }));
  }

  async revokeSession(actor: AuthenticatedUser, sessionId: string, context: RequestAuditContext = {}) {
    const result = await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId: actor.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'revocada_usuario' },
    });
    if (result.count === 0) throw new NotFoundException('Sesión no encontrada');
    await this.auditService.record({
      eventType: 'SESSIONS_REVOKED',
      outcome: 'SUCCESS',
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'SESSION',
      targetId: sessionId,
      details: { alcance: 'propia', revocadas: 1 },
      ...context,
    });
    return { revocadas: 1 };
  }
}
