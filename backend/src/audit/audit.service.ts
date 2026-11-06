import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
import type { AuditEventInput, AuditEventType, AuditTransactionClient } from './audit.types.js';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto.js';
import type { AuditExportFormat, ExportAuditLogsDto } from './dto/export-audit-logs.dto.js';

const CONNECTION_FIELDS = new Set(['nombre', 'tipoMotor', 'host', 'dbName', 'connectionString', 'credenciales']);
/** Eventos de alta/baja de miembros: guardan rol, correo afectado y vencimiento de la invitación. */
const MEMBERSHIP_EVENTS: ReadonlySet<AuditEventType> = new Set([
  'USER_INVITED',
  'INVITATION_RESENT',
  'INVITATION_REVOKED',
  'INVITATION_ACCEPTED',
  'USER_REMOVED',
]);
const WORKSPACE_FIELDS = new Set([
  'nombreEmpresa',
  'logoUrl',
  'zonaHoraria',
  'dominiosPermitidos',
  'camposSensibles',
]);

/** Datos de un Cross-Join que se guardan en la bitácora. Nunca se guardan filtros ni valores de filas. */
const DATA_ACCESS_STRING_FIELDS = [
  'conexionSqlId',
  'conexionNoSqlId',
  'esquemaSql',
  'tablaSql',
  'coleccionNoSql',
  'entidades',
  'conexiones',
  'tiposJoin',
  'formato',
  'error',
] as const;
const DATA_ACCESS_NUMBER_FIELDS = ['totalFilas', 'filtrosSql', 'filtrosNoSql', 'fuentes', 'filtros'] as const;
const DATA_ACCESS_BOOLEAN_FIELDS = ['enmascarado', 'agregado'] as const;

/** Máximo de registros por archivo exportado de la bitácora. */
export const MAX_AUDIT_EXPORT_ROWS = 10_000;

const EXPORT_COLUMNS = [
  'createdAt',
  'eventType',
  'outcome',
  'actorEmail',
  'actorUserId',
  'targetType',
  'targetId',
  'ipAddress',
  'userAgent',
  'detailsJson',
  'id',
] as const;

type AuditLogRow = {
  id: string;
  eventType: string;
  outcome: string;
  actorUserId: string | null;
  actorEmail: string | null;
  workspaceId: string | null;
  targetType: string | null;
  targetId: string | null;
  detailsJson: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
};

export interface PaginatedAuditLogsResult {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  data: AuditLogRow[];
}

export interface AuditExportResult {
  buffer: Buffer;
  contentType: string;
  filename: string;
  /** true si había más registros que MAX_AUDIT_EXPORT_ROWS y el archivo se recortó. */
  truncated: boolean;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserta un evento en la bitácora. La tabla es de solo inserción: no existe ningún
   * método para modificar o borrar registros (RF-26).
   */
  async record(input: AuditEventInput, tx?: AuditTransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    // La columna es TIMESTAMP sin zona horaria y Prisma la lee como UTC. Se envía la hora UTC
    // desde la app: CURRENT_TIMESTAMP usaría la zona horaria del servidor de base de datos.
    const createdAtUtc = new Date().toISOString();

    await client.$executeRaw`
      INSERT INTO "RegistroAuditoria" (
        "id", "eventType", "outcome", "actorUserId", "actorEmail", "workspaceId",
        "targetType", "targetId", "detailsJson", "ipAddress", "userAgent", "createdAt"
      ) VALUES (
        ${randomUUID()}, ${input.eventType}::"AuditEventType", ${input.outcome}, ${input.actorUserId ?? null},
        ${input.actorEmail ?? null}, ${input.workspaceId ?? null}, ${input.targetType ?? null},
        ${input.targetId?.slice(0, 512) ?? null}, ${this.serializeSafeDetails(input.eventType, input.details)},
        ${input.ipAddress?.slice(0, 128) ?? null}, ${input.userAgent?.slice(0, 512) ?? null},
        ${createdAtUtc}::timestamp
      )
    `;
  }

  /**
   * Consulta paginada y filtrada de la bitácora de auditoría para el Workspace del actor.
   * Requiere permiso READ_AUDIT (ADMIN o AUDITOR).
   */
  async findAll(
    actor: AuthenticatedUser,
    query: QueryAuditLogsDto,
  ): Promise<PaginatedAuditLogsResult> {
    this.assertCanRead(actor);

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 50;
    const skip = (page - 1) * limit;
    const where = this.buildWhere(actor, query);

    const [total, data] = await Promise.all([
      this.prisma.registroAuditoria.count({ where }),
      this.prisma.registroAuditoria.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data,
    };
  }

  /**
   * Exporta la bitácora filtrada a CSV o JSON (máximo MAX_AUDIT_EXPORT_ROWS registros).
   * La propia exportación queda registrada como AUDIT_LOG_EXPORTED.
   */
  async exportLogs(
    actor: AuthenticatedUser,
    query: ExportAuditLogsDto,
    context: RequestAuditContext = {},
  ): Promise<AuditExportResult> {
    this.assertCanRead(actor);

    const format: AuditExportFormat = query.format ?? 'csv';
    const where = this.buildWhere(actor, query);
    const rows: AuditLogRow[] = await this.prisma.registroAuditoria.findMany({
      where,
      take: MAX_AUDIT_EXPORT_ROWS + 1,
      orderBy: { createdAt: 'desc' },
    });
    const truncated = rows.length > MAX_AUDIT_EXPORT_ROWS;
    const exported = truncated ? rows.slice(0, MAX_AUDIT_EXPORT_ROWS) : rows;

    await this.record({
      eventType: 'AUDIT_LOG_EXPORTED',
      outcome: 'SUCCESS',
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'AUDIT_LOG',
      details: {
        formato: format,
        totalFilas: exported.length,
        ...(query.tipoAccion ? { tipoAccion: query.tipoAccion } : {}),
        ...(query.fechaInicio ? { fechaInicio: query.fechaInicio } : {}),
        ...(query.fechaFin ? { fechaFin: query.fechaFin } : {}),
      },
      ...context,
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'json') {
      return {
        buffer: Buffer.from(JSON.stringify(exported, null, 2), 'utf8'),
        contentType: 'application/json; charset=utf-8',
        filename: `datanexus_auditoria_${timestamp}.json`,
        truncated,
      };
    }

    return {
      buffer: Buffer.from(this.toCsv(exported), 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      filename: `datanexus_auditoria_${timestamp}.csv`,
      truncated,
    };
  }

  private assertCanRead(actor: AuthenticatedUser): void {
    if (!hasPermission(actor.role, 'READ_AUDIT')) {
      throw new ForbiddenException('Se requiere rol ADMIN o AUDITOR para consultar los logs de auditoría');
    }
  }

  private buildWhere(
    actor: AuthenticatedUser,
    query: Pick<QueryAuditLogsDto, 'tipoAccion' | 'fechaInicio' | 'fechaFin'>,
  ): Prisma.RegistroAuditoriaWhereInput {
    const where: Prisma.RegistroAuditoriaWhereInput = {
      workspaceId: actor.workspaceId,
    };

    if (query.tipoAccion) {
      where.eventType = query.tipoAccion;
    }

    if (query.fechaInicio || query.fechaFin) {
      where.createdAt = {
        ...(query.fechaInicio ? { gte: new Date(query.fechaInicio) } : {}),
        ...(query.fechaFin ? { lte: new Date(query.fechaFin) } : {}),
      };
    }

    return where;
  }

  /** CSV con BOM (para Excel), escapado RFC 4180 y protección contra inyección de fórmulas. */
  private toCsv(rows: AuditLogRow[]): string {
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      let text = value instanceof Date ? value.toISOString() : String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [
      EXPORT_COLUMNS.join(','),
      ...rows.map((row) => EXPORT_COLUMNS.map((column) => escape(row[column])).join(',')),
    ];
    return `﻿${lines.join('\r\n')}\r\n`;
  }

  private serializeSafeDetails(
    eventType: AuditEventType,
    details: Record<string, unknown> | undefined,
  ): string | null {
    if (!details) return null;

    const safeDetails: Record<string, unknown> = {};

    if (eventType === 'USER_ROLE_CHANGED') {
      for (const key of ['previousRole', 'newRole']) {
        if (typeof details[key] === 'string') safeDetails[key] = details[key];
      }
    }

    if (MEMBERSHIP_EVENTS.has(eventType)) {
      if (typeof details.role === 'string') safeDetails.role = details.role.slice(0, 32);
      if (typeof details.email === 'string') safeDetails.email = details.email.slice(0, 254);
      if (typeof details.expiraEn === 'string') safeDetails.expiraEn = details.expiraEn.slice(0, 64);
    }

    if (eventType === 'CONNECTION_CREATED' || eventType === 'CONNECTION_DELETED') {
      for (const key of ['tipoMotor', 'dbName']) {
        if (typeof details[key] === 'string') safeDetails[key] = details[key];
      }
    }

    if (eventType === 'CONNECTION_UPDATED' && Array.isArray(details.changedFields)) {
      const changedFields = details.changedFields.filter(
        (field): field is string => typeof field === 'string' && CONNECTION_FIELDS.has(field),
      );
      if (changedFields.length > 0) safeDetails.changedFields = [...new Set(changedFields)];
    }

    if (eventType === 'WORKSPACE_UPDATED') {
      Object.assign(safeDetails, this.safeWorkspaceChanges(details));
    }

    if (eventType === 'EXECUTE_JOIN' || eventType === 'EXPORT') {
      for (const key of DATA_ACCESS_STRING_FIELDS) {
        if (typeof details[key] === 'string') safeDetails[key] = (details[key] as string).slice(0, 300);
      }
      for (const key of DATA_ACCESS_NUMBER_FIELDS) {
        if (typeof details[key] === 'number' && Number.isFinite(details[key])) safeDetails[key] = details[key];
      }
      for (const key of DATA_ACCESS_BOOLEAN_FIELDS) {
        if (typeof details[key] === 'boolean') safeDetails[key] = details[key];
      }
    }

    if (
      (eventType === 'PASSWORD_RESET_REQUESTED' ||
        eventType === 'PASSWORD_RESET' ||
        eventType === 'SESSION_EXPIRED' ||
        eventType === 'LOGIN_FAILURE' ||
        eventType === 'INVITATION_ACCEPTED') &&
      typeof details.motivo === 'string'
    ) {
      safeDetails.motivo = details.motivo.slice(0, 64);
    }

    if (eventType === 'LOGIN_FAILURE' || eventType === 'ACCOUNT_LOCKED') {
      for (const key of ['intentos', 'bloqueoMinutos']) {
        if (typeof details[key] === 'number' && Number.isFinite(details[key])) safeDetails[key] = details[key];
      }
      if (typeof details.bloqueadoHasta === 'string') safeDetails.bloqueadoHasta = details.bloqueadoHasta;
    }

    if (eventType === 'AUDIT_LOG_EXPORTED') {
      for (const key of ['formato', 'tipoAccion', 'fechaInicio', 'fechaFin']) {
        if (typeof details[key] === 'string') safeDetails[key] = details[key];
      }
      if (typeof details.totalFilas === 'number') safeDetails.totalFilas = details.totalFilas;
    }

    return Object.keys(safeDetails).length > 0 ? JSON.stringify(safeDetails) : null;
  }

  /** Antes/después de los campos editables del workspace: solo textos, null o listas de textos acotadas. */
  private safeWorkspaceChanges(details: Record<string, unknown>): Record<string, unknown> {
    const safeValue = (value: unknown): unknown => {
      if (value === null || typeof value === 'string') return value?.slice(0, 2048) ?? null;
      if (Array.isArray(value)) {
        return value
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 200)
          .map((item) => item.slice(0, 253));
      }
      return undefined;
    };

    const campos = Array.isArray(details.campos)
      ? [...new Set(details.campos.filter((f): f is string => typeof f === 'string' && WORKSPACE_FIELDS.has(f)))]
      : [];
    if (campos.length === 0) return {};

    const cambiosInput = (details.cambios ?? {}) as Record<string, { antes?: unknown; despues?: unknown } | undefined>;
    const cambios: Record<string, { antes: unknown; despues: unknown }> = {};
    for (const field of campos) {
      const change = cambiosInput[field];
      const antes = safeValue(change?.antes);
      const despues = safeValue(change?.despues);
      if (antes !== undefined && despues !== undefined) cambios[field] = { antes, despues };
    }

    return { campos, cambios };
  }
}
