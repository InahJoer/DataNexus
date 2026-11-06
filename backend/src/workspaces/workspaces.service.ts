import {
  BadRequestException,
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
import { USER_ROLES, hasPermission, type UserRole } from '../auth/interfaces/user-role.js';
import { TIPOS_MOTOR, type TipoMotor } from '../common/tipo-motor.js';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto.js';
import type { WorkspaceResponseDto, WorkspaceStatsDto } from './dto/workspace-response.dto.js';
import { normalizeAllowedDomains, normalizeSensitiveFields } from './workspace-settings.js';

const WORKSPACE_SELECT = {
  id: true,
  nombreEmpresa: true,
  logoUrl: true,
  zonaHoraria: true,
  dominiosPermitidos: true,
  camposSensibles: true,
  fechaCreacion: true,
  fechaActualizacion: true,
} as const satisfies Prisma.WorkspaceSelect;

type WorkspaceRow = Prisma.WorkspaceGetPayload<{ select: typeof WORKSPACE_SELECT }>;

/** Campos editables por PATCH /workspaces/me. */
const EDITABLE_FIELDS = [
  'nombreEmpresa',
  'logoUrl',
  'zonaHoraria',
  'dominiosPermitidos',
  'camposSensibles',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];
type WorkspaceChanges = Partial<Pick<WorkspaceRow, EditableField>>;

/**
 * Gestión del espacio de trabajo (RF-05).
 *
 * Aislamiento multi-tenant: el workspace se toma siempre del JWT (`actor.workspaceId`), nunca de la
 * URL ni del body, así que no existe forma de leer o modificar el workspace de otra empresa.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /** Workspace del usuario autenticado. La configuración solo se expone a quien puede editarla. */
  async findMine(actor: AuthenticatedUser): Promise<WorkspaceResponseDto> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: actor.workspaceId },
      select: WORKSPACE_SELECT,
    });
    if (!workspace) throw new NotFoundException('Workspace no encontrado');
    return this.toResponse(workspace, actor.role);
  }

  /** Actualiza nombre, logo, zona horaria y configuración. Solo ADMIN; el cambio y su auditoría son atómicos. */
  async updateMine(
    actor: AuthenticatedUser,
    dto: UpdateWorkspaceDto,
    requestContext: RequestAuditContext = {},
  ): Promise<WorkspaceResponseDto> {
    if (!hasPermission(actor.role, 'MANAGE_WORKSPACE')) {
      throw new ForbiddenException('Se requiere rol ADMIN para modificar el workspace');
    }

    const requested = this.normalize(dto);
    if (Object.keys(requested).length === 0) {
      throw new BadRequestException('Indica al menos un campo a modificar');
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.workspace.findUnique({
        where: { id: actor.workspaceId },
        select: WORKSPACE_SELECT,
      });
      if (!current) throw new NotFoundException('Workspace no encontrado');

      const changes = this.diff(current, requested);
      const changedFields = Object.keys(changes) as EditableField[];
      if (changedFields.length === 0) return this.toResponse(current, actor.role);

      const updated = await tx.workspace.update({
        where: { id: actor.workspaceId },
        data: changes,
        select: WORKSPACE_SELECT,
      });

      await this.auditService.record(
        {
          eventType: 'WORKSPACE_UPDATED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'WORKSPACE',
          targetId: actor.workspaceId,
          details: {
            campos: changedFields,
            cambios: Object.fromEntries(
              changedFields.map((field) => [field, { antes: current[field], despues: updated[field] }]),
            ),
          },
          ...requestContext,
        },
        tx,
      );

      return this.toResponse(updated, actor.role);
    });
  }

  /** Estadísticas del workspace: miembros por rol, conexiones por motor y reportes enviados. */
  async getStats(actor: AuthenticatedUser): Promise<WorkspaceStatsDto> {
    const workspaceId = actor.workspaceId;
    const reportWhere = {
      workspaceId,
      eventType: 'REPORT_GENERATED_AND_SENT',
      outcome: 'SUCCESS',
    } as const satisfies Prisma.RegistroAuditoriaWhereInput;

    const [usersByRole, connectionsByEngine, reportsSent, lastReport] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], where: { workspaceId }, _count: { _all: true } }),
      this.prisma.conexionDB.groupBy({ by: ['tipoMotor'], where: { workspaceId }, _count: { _all: true } }),
      this.prisma.registroAuditoria.count({ where: reportWhere }),
      this.prisma.registroAuditoria.findFirst({
        where: reportWhere,
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    const porRol = Object.fromEntries(USER_ROLES.map((role) => [role, 0])) as Record<UserRole, number>;
    for (const row of usersByRole) porRol[row.role as UserRole] = row._count._all;

    const porMotor = Object.fromEntries(TIPOS_MOTOR.map((motor) => [motor, 0])) as Record<TipoMotor, number>;
    for (const row of connectionsByEngine) porMotor[row.tipoMotor as TipoMotor] = row._count._all;

    return {
      miembros: { total: sum(porRol), porRol },
      conexiones: { total: sum(porMotor), porMotor },
      reportes: { enviados: reportsSent, ultimoEnvio: lastReport?.createdAt ?? null },
    };
  }

  /** Limpia y valida los campos enviados. Lanza 400 con los valores rechazados. */
  private normalize(dto: UpdateWorkspaceDto): WorkspaceChanges {
    const changes: WorkspaceChanges = {};

    if (dto.nombreEmpresa !== undefined) changes.nombreEmpresa = dto.nombreEmpresa;
    if (dto.logoUrl !== undefined) changes.logoUrl = dto.logoUrl || null;
    if (dto.zonaHoraria !== undefined) changes.zonaHoraria = dto.zonaHoraria;

    if (dto.dominiosPermitidos !== undefined) {
      const result = normalizeAllowedDomains(dto.dominiosPermitidos);
      if (!result.ok) {
        throw new BadRequestException(
          `Dominios no válidos o de correo personal: ${result.invalid.join(', ')}`,
        );
      }
      changes.dominiosPermitidos = result.values;
    }

    if (dto.camposSensibles !== undefined) {
      const result = normalizeSensitiveFields(dto.camposSensibles);
      if (!result.ok) {
        throw new BadRequestException(`Nombres de campo no válidos: ${result.invalid.join(', ')}`);
      }
      changes.camposSensibles = result.values;
    }

    return changes;
  }

  /** Conserva solo los campos cuyo valor cambia respecto al actual. */
  private diff(current: WorkspaceRow, requested: WorkspaceChanges): WorkspaceChanges {
    return Object.fromEntries(
      Object.entries(requested).filter(
        ([field, value]) => JSON.stringify(current[field as EditableField]) !== JSON.stringify(value),
      ),
    ) as WorkspaceChanges;
  }

  private toResponse(workspace: WorkspaceRow, role: UserRole): WorkspaceResponseDto {
    const { dominiosPermitidos, camposSensibles, ...publicFields } = workspace;
    if (!hasPermission(role, 'MANAGE_WORKSPACE')) return publicFields;
    return { ...publicFields, configuracion: { dominiosPermitidos, camposSensibles } };
  }
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}
