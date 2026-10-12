import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from '../auth/interfaces/authenticated-user.interface.js';

export type UserRole = 'ADMIN' | 'LECTOR';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async updateRole(
    actor: AuthenticatedUser,
    targetUserId: string,
    newRole: UserRole,
    requestContext: RequestAuditContext = {},
  ) {
    if (actor.role !== 'ADMIN') {
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

      const updatedUser = await tx.user.update({
        where: { id: targetUserId },
        data: { role: newRole },
        select: { id: true, email: true, name: true, role: true, workspaceId: true },
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
}
