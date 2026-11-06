import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mailer/mail.service.js';
import { renderInvitationEmail } from '../mailer/templates/invitation.template.js';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from '../auth/interfaces/authenticated-user.interface.js';
import { ROLE_LABELS, hasPermission, type UserRole } from '../auth/interfaces/user-role.js';
import { isEmailDomainAllowed } from '../workspaces/workspace-settings.js';
import type { InviteUserDto } from './dto/invite-user.dto.js';
import type {
  AcceptInvitationDto,
  InvitationPreviewDto,
  InvitationResponseDto,
  InvitationState,
} from './dto/invitation.dto.js';

export const DEFAULT_INVITATION_TTL_HOURS = 72;

export const INVALID_INVITATION_MESSAGE =
  'La invitación es inválida, ya fue usada, fue revocada o expiró. Pide al administrador que te envíe una nueva.';

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const INVITATION_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  acceptedAt: true,
  revokedAt: true,
  workspaceId: true,
  invitedBy: { select: { id: true, name: true, email: true } },
} as const satisfies Prisma.InvitationSelect;

type InvitationRow = Prisma.InvitationGetPayload<{ select: typeof INVITATION_SELECT }>;

/**
 * Invitaciones por enlace (RF-06).
 * - El token es aleatorio (256 bits); en la base solo se guarda su hash SHA-256.
 * - Vence a las INVITATION_TTL_HOURS (72 por defecto) y es de un solo uso.
 * - Reenviar genera un token nuevo (el anterior deja de servir) y renueva el vencimiento.
 * - El usuario se crea recién al aceptar, con la contraseña que él mismo elige.
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  private get ttlHours(): number {
    const value = Number(this.configService.get('INVITATION_TTL_HOURS'));
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_INVITATION_TTL_HOURS;
  }

  private get frontendUrl(): string {
    return (this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  /** Crea la invitación y envía el enlace por correo. Solo ADMIN. */
  async invite(
    actor: AuthenticatedUser,
    dto: InviteUserDto,
    context: RequestAuditContext = {},
  ): Promise<InvitationResponseDto> {
    this.assertCanManage(actor);
    const email = dto.email.trim().toLowerCase();

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: actor.workspaceId },
      select: { nombreEmpresa: true, dominiosPermitidos: true },
    });
    if (!workspace) throw new NotFoundException('Workspace no encontrado');
    if (!isEmailDomainAllowed(email, workspace.dominiosPermitidos)) {
      throw new BadRequestException(
        `El correo debe pertenecer a un dominio permitido del workspace: ${workspace.dominiosPermitidos.join(', ')}`,
      );
    }

    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ConflictException(`Ya existe un usuario registrado con el correo ${email}`);
    }

    const pending = await this.prisma.invitation.findFirst({
      where: { workspaceId: actor.workspaceId, email, status: 'PENDIENTE', expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictException(
        `Ya existe una invitación pendiente para ${email}. Reenvíala o revócala antes de crear otra.`,
      );
    }

    const token = this.newToken();
    const invitation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invitation.create({
        data: {
          email,
          name: dto.name,
          role: dto.role,
          tokenHash: hashInvitationToken(token),
          expiresAt: this.newExpiry(),
          workspaceId: actor.workspaceId,
          invitedById: actor.id,
        },
        select: INVITATION_SELECT,
      });
      await this.auditService.record(
        {
          eventType: 'USER_INVITED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'INVITATION',
          targetId: created.id,
          details: { email, role: created.role, expiraEn: created.expiresAt.toISOString() },
          ...context,
        },
        tx,
      );
      return created;
    });

    const correoEnviado = await this.sendInvitationEmail(invitation, token, actor.name, workspace.nombreEmpresa);
    return Object.assign(this.toResponse(invitation), { correoEnviado });
  }

  /** Invitaciones del workspace del actor, opcionalmente filtradas por estado. Solo ADMIN. */
  async list(actor: AuthenticatedUser, estado?: InvitationState): Promise<InvitationResponseDto[]> {
    this.assertCanManage(actor);
    const now = new Date();
    const byState: Record<InvitationState, Prisma.InvitationWhereInput> = {
      PENDIENTE: { status: 'PENDIENTE', expiresAt: { gt: now } },
      EXPIRADA: { status: 'PENDIENTE', expiresAt: { lte: now } },
      ACEPTADA: { status: 'ACEPTADA' },
      REVOCADA: { status: 'REVOCADA' },
    };

    const invitations = await this.prisma.invitation.findMany({
      where: { workspaceId: actor.workspaceId, ...(estado ? byState[estado] : {}) },
      select: INVITATION_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return invitations.map((invitation) => this.toResponse(invitation, now));
  }

  /** Reenvía una invitación pendiente o expirada con un token nuevo y un vencimiento renovado. */
  async resend(
    actor: AuthenticatedUser,
    invitationId: string,
    context: RequestAuditContext = {},
  ): Promise<InvitationResponseDto> {
    this.assertCanManage(actor);
    const current = await this.findInWorkspace(actor, invitationId);
    if (current.status !== 'PENDIENTE') {
      throw new ConflictException(`No se puede reenviar una invitación ${current.status.toLowerCase()}`);
    }
    if (await this.prisma.user.findUnique({ where: { email: current.email }, select: { id: true } })) {
      throw new ConflictException(`El correo ${current.email} ya pertenece a un usuario registrado`);
    }

    const token = this.newToken();
    const invitation = await this.prisma.$transaction(async (tx) => {
      const rotated = await tx.invitation.updateMany({
        where: { id: current.id, status: 'PENDIENTE' },
        data: { tokenHash: hashInvitationToken(token), expiresAt: this.newExpiry() },
      });
      if (rotated.count !== 1) throw new ConflictException('La invitación cambió de estado; vuelve a cargarla');

      const updated = await tx.invitation.findUniqueOrThrow({ where: { id: current.id }, select: INVITATION_SELECT });
      await this.auditService.record(
        {
          eventType: 'INVITATION_RESENT',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'INVITATION',
          targetId: updated.id,
          details: { email: updated.email, role: updated.role, expiraEn: updated.expiresAt.toISOString() },
          ...context,
        },
        tx,
      );
      return updated;
    });

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: actor.workspaceId },
      select: { nombreEmpresa: true },
    });
    const correoEnviado = await this.sendInvitationEmail(
      invitation,
      token,
      actor.name,
      workspace?.nombreEmpresa ?? 'DataNexus',
    );
    return Object.assign(this.toResponse(invitation), { correoEnviado });
  }

  /** Revoca una invitación pendiente: su enlace deja de servir de inmediato. */
  async revoke(
    actor: AuthenticatedUser,
    invitationId: string,
    context: RequestAuditContext = {},
  ): Promise<InvitationResponseDto> {
    this.assertCanManage(actor);
    const current = await this.findInWorkspace(actor, invitationId);
    if (current.status !== 'PENDIENTE') {
      throw new ConflictException(`La invitación ya está ${current.status.toLowerCase()}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.invitation.updateMany({
        where: { id: current.id, status: 'PENDIENTE' },
        data: { status: 'REVOCADA', revokedAt: new Date() },
      });
      if (revoked.count !== 1) throw new ConflictException('La invitación cambió de estado; vuelve a cargarla');

      const updated = await tx.invitation.findUniqueOrThrow({ where: { id: current.id }, select: INVITATION_SELECT });
      await this.auditService.record(
        {
          eventType: 'INVITATION_REVOKED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'INVITATION',
          targetId: updated.id,
          details: { email: updated.email, role: updated.role },
          ...context,
        },
        tx,
      );
      return this.toResponse(updated);
    });
  }

  /** Datos públicos de una invitación válida, para que el cliente muestre a qué workspace se une. */
  async preview(token: string): Promise<InvitationPreviewDto> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
      select: {
        email: true,
        name: true,
        role: true,
        status: true,
        expiresAt: true,
        workspace: { select: { nombreEmpresa: true } },
      },
    });
    if (!invitation || !this.isUsable(invitation)) throw new BadRequestException(INVALID_INVITATION_MESSAGE);

    return {
      email: invitation.email,
      name: invitation.name,
      role: invitation.role as UserRole,
      nombreEmpresa: invitation.workspace.nombreEmpresa,
      expiresAt: invitation.expiresAt,
    };
  }

  /** Acepta la invitación: crea el usuario con la contraseña elegida y consume el token (un solo uso). */
  async accept(dto: AcceptInvitationDto, context: RequestAuditContext = {}): Promise<{ message: string }> {
    const tokenHash = hashInvitationToken(dto.token);
    const passwordHash = await bcrypt.hash(dto.password, 10);

    let user: { id: string; email: string; workspaceId: string; role: string } | null;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const invitation = await tx.invitation.findUnique({ where: { tokenHash } });
        if (!invitation || !this.isUsable(invitation)) return null;

        // Consumo atómico: si dos peticiones usan el mismo enlace a la vez, solo una gana.
        const consumed = await tx.invitation.updateMany({
          where: { id: invitation.id, status: 'PENDIENTE', expiresAt: { gt: new Date() } },
          data: { status: 'ACEPTADA', acceptedAt: new Date() },
        });
        if (consumed.count !== 1) return null;

        if (await tx.user.findUnique({ where: { email: invitation.email }, select: { id: true } })) {
          throw new ConflictException('Ya existe una cuenta con este correo. Inicia sesión o recupera tu contraseña.');
        }

        const created = await tx.user.create({
          data: {
            email: invitation.email,
            name: dto.name ?? invitation.name,
            role: invitation.role,
            password: passwordHash,
            workspaceId: invitation.workspaceId,
          },
          select: { id: true, email: true, workspaceId: true, role: true },
        });

        await this.auditService.record(
          {
            eventType: 'INVITATION_ACCEPTED',
            outcome: 'SUCCESS',
            actorUserId: created.id,
            actorEmail: created.email,
            workspaceId: created.workspaceId,
            targetType: 'INVITATION',
            targetId: invitation.id,
            details: { email: created.email, role: created.role },
            ...context,
          },
          tx,
        );
        return created;
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ya existe una cuenta con este correo. Inicia sesión o recupera tu contraseña.');
      }
      throw error;
    }

    if (!user) {
      await this.auditService.record({
        eventType: 'INVITATION_ACCEPTED',
        outcome: 'FAILURE',
        details: { motivo: 'token_invalido_o_expirado' },
        ...context,
      });
      throw new BadRequestException(INVALID_INVITATION_MESSAGE);
    }

    return { message: 'Tu cuenta quedó activada. Ya puedes iniciar sesión.' };
  }

  private assertCanManage(actor: AuthenticatedUser): void {
    if (!hasPermission(actor.role, 'MANAGE_MEMBERS')) {
      throw new ForbiddenException('Se requiere rol ADMIN para gestionar invitaciones');
    }
  }

  private async findInWorkspace(actor: AuthenticatedUser, invitationId: string): Promise<InvitationRow> {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, workspaceId: actor.workspaceId },
      select: INVITATION_SELECT,
    });
    if (!invitation) throw new NotFoundException('Invitación no encontrada en el workspace');
    return invitation;
  }

  private isUsable(invitation: { status: string; expiresAt: Date }): boolean {
    return invitation.status === 'PENDIENTE' && invitation.expiresAt.getTime() > Date.now();
  }

  private newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private newExpiry(): Date {
    return new Date(Date.now() + this.ttlHours * 3_600_000);
  }

  /** Envía el correo; si falla no se pierde la invitación: el ADMIN puede reenviarla. */
  private async sendInvitationEmail(
    invitation: InvitationRow,
    token: string,
    inviterName: string,
    workspaceName: string,
  ): Promise<boolean> {
    const acceptUrl = `${this.frontendUrl}/accept-invite?token=${encodeURIComponent(token)}`;
    const email = renderInvitationEmail({
      name: invitation.name,
      inviterName,
      workspaceName,
      roleLabel: ROLE_LABELS[invitation.role as UserRole] ?? invitation.role,
      acceptUrl,
      expiresInHours: this.ttlHours,
    });

    try {
      await this.mailService.sendMail({ to: invitation.email, ...email });
      return true;
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo enviar la invitación ${invitation.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private toResponse(invitation: InvitationRow, now = new Date()): InvitationResponseDto {
    const { status } = invitation;
    const estado: InvitationState =
      status === 'PENDIENTE' && invitation.expiresAt.getTime() <= now.getTime() ? 'EXPIRADA' : status;
    // Lista explícita: nunca se devuelve tokenHash ni workspaceId.
    return {
      id: invitation.id,
      email: invitation.email,
      name: invitation.name,
      role: invitation.role as UserRole,
      estado,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt,
      invitedBy: invitation.invitedBy,
    };
  }
}
