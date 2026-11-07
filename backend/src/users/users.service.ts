import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission, type UserRole } from '../auth/interfaces/user-role.js';

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  workspaceId: true,
} as const;

export const LAST_ADMIN_MESSAGE =
  'El workspace debe conservar al menos un ADMINISTRADOR; asigna el rol a otro miembro antes.';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Lista todos los miembros del workspace al que pertenece el usuario autenticado.
   */
  async findAll(actor: AuthenticatedUser) {
    const now = new Date();
    const users = await this.prisma.user.findMany({
      where: { workspaceId: actor.workspaceId },
      select: {
        ...SAFE_USER_SELECT,
        lockedUntil: true,
        sessions: { select: { lastActivityAt: true, revokedAt: true, expiresAt: true }, orderBy: { lastActivityAt: 'desc' }, take: 50 },
      },
      orderBy: { name: 'asc' },
    });
    // Último acceso = última actividad de cualquier sesión; activas = no revocadas ni vencidas.
    return users.map(({ sessions, lockedUntil, ...user }) => ({
      ...user,
      ultimoAcceso: sessions[0]?.lastActivityAt ?? null,
      sesionesActivas: sessions.filter((session) => !session.revokedAt && session.expiresAt > now).length,
      bloqueado: Boolean(lockedUntil && lockedUntil > now),
      esUstedMismo: user.id === actor.id,
    }));
  }

  /** Cierra las sesiones de un miembro (ADMIN). Su siguiente petición recibe 401. */
  async revokeUserSessions(actor: AuthenticatedUser, targetUserId: string, requestContext: RequestAuditContext = {}) {
    if (!hasPermission(actor.role, 'MANAGE_MEMBERS')) throw new ForbiddenException('Se requiere rol ADMIN para cerrar sesiones');
    const target = await this.prisma.user.findFirst({ where: { id: targetUserId, workspaceId: actor.workspaceId }, select: { id: true, email: true } });
    if (!target) throw new NotFoundException('Usuario no encontrado en el workspace');
    const result = await this.prisma.userSession.updateMany({
      where: { userId: target.id, revokedAt: null, ...(actor.sessionId ? { id: { not: actor.sessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: 'revocada_admin' },
    });
    await this.auditService.record({
      eventType: 'SESSIONS_REVOKED',
      outcome: 'SUCCESS',
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'USER',
      targetId: target.id,
      details: { alcance: 'usuario', usuario: target.email, revocadas: result.count },
      ...requestContext,
    });
    return { revocadas: result.count };
  }

  /** Cierra todas las sesiones del workspace salvo la del propio ADMIN (p. ej. ante un incidente). */
  async revokeAllSessions(actor: AuthenticatedUser, requestContext: RequestAuditContext = {}) {
    if (!hasPermission(actor.role, 'MANAGE_MEMBERS')) throw new ForbiddenException('Se requiere rol ADMIN para cerrar sesiones');
    const result = await this.prisma.userSession.updateMany({
      where: { revokedAt: null, user: { workspaceId: actor.workspaceId }, ...(actor.sessionId ? { id: { not: actor.sessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: 'revocada_admin' },
    });
    await this.auditService.record({
      eventType: 'SESSIONS_REVOKED',
      outcome: 'SUCCESS',
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'WORKSPACE',
      targetId: actor.workspaceId,
      details: { alcance: 'workspace', revocadas: result.count },
      ...requestContext,
    });
    return { revocadas: result.count };
  }

  async updateRole(
    actor: AuthenticatedUser,
    targetUserId: string,
    newRole: UserRole,
    requestContext: RequestAuditContext = {},
  ) {
    if (!hasPermission(actor.role, 'MANAGE_MEMBERS')) {
      throw new ForbiddenException('Se requiere rol ADMIN para cambiar roles');
    }
    if (actor.id === targetUserId) {
      throw new ForbiddenException('Un ADMIN no puede cambiar su propio rol');
    }

    return this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, email: true, name: true, role: true, workspaceId: true },
      });

      if (!target || target.workspaceId !== actor.workspaceId) {
        throw new NotFoundException('Usuario no encontrado en el workspace');
      }

      if (target.role === newRole) return target;
      if (target.role === 'ADMIN') await this.assertNotLastAdmin(tx, actor.workspaceId);

      const updatedUser = await tx.user.update({
        where: { id: targetUserId },
        data: { role: newRole },
        select: SAFE_USER_SELECT,
      });

      await this.auditService.record(
        {
          eventType: 'USER_ROLE_CHANGED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'USER',
          targetId: targetUserId,
          details: { previousRole: target.role, newRole },
          ...requestContext,
        },
        tx,
      );

      return updatedUser;
    });
  }

  /**
   * Da de baja a un miembro del workspace (RF-06): borra su cuenta y, en cascada, sus sesiones.
   * No se puede dar de baja uno mismo ni dejar el workspace sin ADMINISTRADOR.
   */
  async removeMember(actor: AuthenticatedUser, targetUserId: string, requestContext: RequestAuditContext = {}) {
    if (!hasPermission(actor.role, 'MANAGE_MEMBERS')) {
      throw new ForbiddenException('Se requiere rol ADMIN para dar de baja miembros');
    }
    if (actor.id === targetUserId) {
      throw new ForbiddenException('No puedes darte de baja a ti mismo; pide a otro ADMINISTRADOR que lo haga');
    }

    return this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetUserId }, select: SAFE_USER_SELECT });
      if (!target || target.workspaceId !== actor.workspaceId) {
        throw new NotFoundException('Usuario no encontrado en el workspace');
      }
      if (target.role === 'ADMIN') await this.assertNotLastAdmin(tx, actor.workspaceId);

      await tx.user.delete({ where: { id: targetUserId } });

      await this.auditService.record(
        {
          eventType: 'USER_REMOVED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'USER',
          targetId: targetUserId,
          details: { email: target.email, role: target.role },
          ...requestContext,
        },
        tx,
      );

      return target;
    });
  }

  /**
   * Bloquea (FOR UPDATE) las filas de ADMIN del workspace y exige que quede más de uno.
   * El bloqueo serializa bajas y cambios de rol concurrentes: dos ADMIN no pueden quitarse mutuamente a la vez.
   */
  private async assertNotLastAdmin(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
    const admins = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE "workspaceId" = ${workspaceId} AND "role" = 'ADMIN'::"Role" ORDER BY "id" FOR UPDATE
    `;
    if (admins.length <= 1) throw new ConflictException(LAST_ADMIN_MESSAGE);
  }
}
