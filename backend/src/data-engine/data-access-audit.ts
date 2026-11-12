import { HttpException } from '@nestjs/common';
import type { AuditEventInput } from '../audit/audit.types.js';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
import { countConditions } from './filters/filter-tree.js';
import type { CrossJoinDto, ExportCrossJoinDto } from './dto/cross-join.dto.js';

/**
 * Construye el evento de bitácora de un Cross-Join o exportación (RF-24/RF-25).
 * Registra qué tabla y colección se tocaron, pero nunca los valores de filtros ni las filas.
 */
export function buildDataAccessAuditEvent(
  eventType: 'EXECUTE_JOIN' | 'EXPORT',
  request: AuthenticatedRequest,
  payload: CrossJoinDto | ExportCrossJoinDto,
  result: { totalFilas?: number; error?: unknown },
): AuditEventInput {
  const user: AuthenticatedUser = request.user;
  const failed = result.error !== undefined;
  const isMultiSource = Array.isArray(payload.fuentes);
  const tabla = payload.esquemaSql ? `${payload.esquemaSql}.${payload.tablaSql}` : payload.tablaSql;
  const fuentes = payload.fuentes ?? [];
  const relaciones = payload.relaciones ?? [];
  const entidades = fuentes
    .map((source) => (source.esquema ? `${source.esquema}.${source.entidad}` : source.entidad))
    .join(' x ');

  const sourceDetails = isMultiSource
    ? {
        entidades,
        conexiones: [...new Set(fuentes.map((source) => source.conexionId))].join(','),
        fuentes: fuentes.length,
        tiposJoin: relaciones.map((relation) => relation.tipo ?? 'INNER').join(','),
        filtros: fuentes.reduce((total, source) => total + countConditions(source.filtros), 0),
      }
    : {
        conexionSqlId: payload.conexionSqlId,
        conexionNoSqlId: payload.conexionNoSqlId,
        esquemaSql: payload.esquemaSql,
        tablaSql: payload.tablaSql,
        coleccionNoSql: payload.coleccionNoSql,
        tiposJoin: payload.tipoJoin ?? 'INNER',
        filtrosSql: countConditions(payload.filtrosSql),
        filtrosNoSql: countConditions(payload.filtrosNoSql),
      };

  return {
    eventType,
    outcome: failed ? 'FAILURE' : 'SUCCESS',
    actorUserId: user.id,
    actorEmail: user.email,
    workspaceId: user.workspaceId,
    targetType: 'CROSS_JOIN',
    targetId: isMultiSource ? entidades : `${tabla} x ${payload.coleccionNoSql}`,
    details: {
      ...sourceDetails,
      agregado: Boolean(payload.groupBy?.length || payload.aggregations?.length),
      enmascarado: !hasPermission(user.role, 'VIEW_UNMASKED_DATA'),
      ...('format' in payload ? { formato: payload.format } : {}),
      ...(result.totalFilas !== undefined ? { totalFilas: result.totalFilas } : {}),
      ...(failed ? { error: describeError(result.error) } : {}),
    },
    ipAddress: request.ip,
    userAgent: request.get?.('user-agent') ?? undefined,
  };
}

function describeError(error: unknown): string {
  if (error instanceof HttpException) return `${error.getStatus()} ${error.name}`;
  if (error instanceof Error) return error.name;
  return 'Error';
}

/** Evento EXPORT de una tabla o colección exportada desde el explorador: qué se exportó, nunca filtros ni filas. */
export function buildDataExportAuditEvent(
  request: AuthenticatedRequest,
  input: { conexionId: string; entidad: string; esquema?: string; format: string; filtros?: unknown },
  result: { totalFilas?: number; error?: unknown },
): AuditEventInput {
  const user: AuthenticatedUser = request.user;
  const failed = result.error !== undefined;
  const entidad = input.esquema ? `${input.esquema}.${input.entidad}` : input.entidad;
  return {
    eventType: 'EXPORT',
    outcome: failed ? 'FAILURE' : 'SUCCESS',
    actorUserId: user.id,
    actorEmail: user.email,
    workspaceId: user.workspaceId,
    targetType: 'CONNECTION',
    targetId: input.conexionId,
    details: {
      entidades: entidad,
      conexiones: input.conexionId,
      fuentes: 1,
      filtros: Array.isArray(input.filtros) ? countConditions(input.filtros as never) : 0,
      formato: input.format,
      enmascarado: !hasPermission(user.role, 'VIEW_UNMASKED_DATA'),
      ...(result.totalFilas !== undefined ? { totalFilas: result.totalFilas } : {}),
      ...(failed ? { error: describeError(result.error) } : {}),
    },
    ipAddress: request.ip,
    userAgent: request.get?.('user-agent') ?? undefined,
  };
}

/** Evento BROWSE_DATA de la exploración paginada (issue #32): qué tabla o colección, nunca filtros ni filas. */
export function buildBrowseAuditEvent(
  request: AuthenticatedRequest,
  connectionId: string,
  query: { entidad: string; esquema?: string; limite?: number; filtros?: string },
  result: { filas?: number; error?: unknown },
): AuditEventInput {
  const user: AuthenticatedUser = request.user;
  const failed = result.error !== undefined;
  let filtros = 0;
  try {
    filtros = query.filtros ? countConditions(JSON.parse(query.filtros) as never) : 0;
  } catch {
    filtros = 0;
  }
  return {
    eventType: 'BROWSE_DATA',
    outcome: failed ? 'FAILURE' : 'SUCCESS',
    actorUserId: user.id,
    actorEmail: user.email,
    workspaceId: user.workspaceId,
    targetType: 'CONNECTION',
    targetId: connectionId,
    details: {
      entidad: query.esquema ? `${query.esquema}.${query.entidad}` : query.entidad,
      limite: query.limite,
      filtros,
      enmascarado: !hasPermission(user.role, 'VIEW_UNMASKED_DATA'),
      ...(result.filas !== undefined ? { filas: result.filas } : {}),
      ...(failed ? { error: describeError(result.error) } : {}),
    },
    ipAddress: request.ip,
    userAgent: request.get?.('user-agent') ?? undefined,
  };
}
