import { HttpException } from '@nestjs/common';
import type { AuditEventInput } from '../audit/audit.types.js';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
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
  const tabla = payload.esquemaSql ? `${payload.esquemaSql}.${payload.tablaSql}` : payload.tablaSql;
  const failed = result.error !== undefined;

  return {
    eventType,
    outcome: failed ? 'FAILURE' : 'SUCCESS',
    actorUserId: user.id,
    actorEmail: user.email,
    workspaceId: user.workspaceId,
    targetType: 'CROSS_JOIN',
    targetId: `${tabla} x ${payload.coleccionNoSql}`,
    details: {
      conexionSqlId: payload.conexionSqlId,
      conexionNoSqlId: payload.conexionNoSqlId,
      esquemaSql: payload.esquemaSql,
      tablaSql: payload.tablaSql,
      coleccionNoSql: payload.coleccionNoSql,
      filtrosSql: payload.filtrosSql?.length ?? 0,
      filtrosNoSql: payload.filtrosNoSql?.length ?? 0,
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
