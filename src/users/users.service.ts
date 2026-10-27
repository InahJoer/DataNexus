import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from '../auth/interfaces/authenticated-user.interface.js';
import { InviteUserDto } from './dto/invite-user.dto.js';

export type UserRole = 'ADMIN' | 'LECTOR';

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  workspaceId: true,
} as const;

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
    return this.prisma.user.findMany({
      where: { workspaceId: actor.workspaceId },
      select: SAFE_USER_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Invita o da de alta un nuevo miembro en el Workspace con contraseña temporal segura.
   * Requiere rol ADMIN.
   */
  async inviteMember(
    actor: AuthenticatedUser,
    dto: InviteUserDto,
    requestContext: RequestAuditContext = {},
  ) {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Se requiere rol ADMIN para invitar miembros');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException(`Ya existe un usuario registrado con el correo ${dto.email}`);
    }

    const rawPassword = dto.temporaryPassword ?? 'DataNexus2026!';
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    const newUser = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        name: dto.name,
        role: dto.role,
        password: hashedPassword,
        workspaceId: actor.workspaceId,
      },
      select: SAFE_USER_SELECT,
    });

    await this.auditService.record({
      eventType: 'USER_ROLE_CHANGED' as any,
      outcome: 'SUCCESS',
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'USER',
      targetId: newUser.id,
      details: { invitedEmail: newUser.email, role: newUser.role },
      ...requestContext,
    });

    return newUser;
  }

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
}
