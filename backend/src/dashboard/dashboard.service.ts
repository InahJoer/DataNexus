import { Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ScheduledReportsService } from '../reports/scheduled-reports.service.js';
import { UsageMeterService } from '../usage/usage-meter.service.js';
import {
  isValidTimeZone,
  lastUtcDays,
  monthRanges,
  percentChange,
  type MonthRange,
} from './dashboard-time.js';
import type {
  ApiUsageMetricDto,
  DashboardConnectionsDto,
  DashboardSummaryDto,
  DataProcessedMetricDto,
  EnvironmentStatusDto,
  RecentActivityDto,
  RecentSavedQueryDto,
} from './dto/dashboard-summary.dto.js';
import { PlatformHealthService } from './platform-health.service.js';

export const DASHBOARD_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
const RECENT_QUERIES = 5;
const RECENT_ACTIVITY = 8;
const UPCOMING_REPORTS = 5;
const BYTES_PER_GB = 1024 ** 3;

const ACTIVITY_LABELS: Record<string, string> = {
  LOGIN_SUCCESS: 'Inició sesión',
  LOGIN_FAILURE: 'Intento de inicio de sesión fallido',
  USER_ROLE_CHANGED: 'Cambió el rol de un miembro',
  USER_INVITED: 'Invitó a un miembro',
  CONNECTION_CREATED: 'Creó una conexión',
  CONNECTION_UPDATED: 'Actualizó una conexión',
  CONNECTION_DELETED: 'Eliminó una conexión',
  REPORT_GENERATED_AND_SENT: 'Generó y envió un reporte',
  EXECUTE_JOIN: 'Ejecutó un Cross-Join',
  EXPORT: 'Exportó datos',
  MODIFY_RECORD: 'Editó un registro en el origen',
  AUDIT_LOG_EXPORTED: 'Exportó la bitácora',
  PASSWORD_RESET_REQUESTED: 'Solicitó recuperar su contraseña',
  PASSWORD_RESET: 'Restableció su contraseña',
  LOGOUT: 'Cerró sesión',
  SESSION_EXPIRED: 'Su sesión expiró',
  REFRESH_TOKEN_REUSED: 'Reutilización de token bloqueada',
  ACCOUNT_LOCKED: 'Cuenta bloqueada por intentos fallidos',
  WORKSPACE_UPDATED: 'Actualizó el workspace',
  INVITATION_RESENT: 'Reenvió una invitación',
  INVITATION_REVOKED: 'Revocó una invitación',
  INVITATION_ACCEPTED: 'Aceptó una invitación',
  USER_REMOVED: 'Dio de baja a un miembro',
  BROWSE_DATA: 'Exploró datos de una fuente',
  SAVED_QUERY_CREATED: 'Guardó una consulta',
  SAVED_QUERY_UPDATED: 'Actualizó una consulta guardada',
  SAVED_QUERY_DELETED: 'Eliminó una consulta guardada',
  SCHEDULED_REPORT_CREATED: 'Programó un reporte',
  SCHEDULED_REPORT_UPDATED: 'Actualizó un reporte programado',
  SCHEDULED_REPORT_DELETED: 'Eliminó un reporte programado',
  SCHEDULED_REPORT_RUN: 'Se ejecutó un reporte programado',
};

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/** Límite mensual de datos procesados del plan (por defecto 1 TB, como el plan Business del diseño). */
export function getDataLimitBytes(): number {
  return intFromEnv('WORKSPACE_DATA_LIMIT_GB', 1024, 1, 1_048_576) * BYTES_PER_GB;
}

/** Latencia a partir de la cual una conexión se marca en el dashboard (por defecto 100 ms). */
export function getLatencyThresholdMs(): number {
  return intFromEnv('CONNECTION_LATENCY_THRESHOLD_MS', 100, 1, 60_000);
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<DashboardSummaryDto>;
}

interface ConnectionRow {
  id: string;
  nombre: string | null;
  tipoMotor: string;
  host: string;
  dbName: string;
  ultimoHealthStatus: string | null;
  ultimaLatenciaMs: number | null;
  ultimoHealthAt: Date | null;
}

/**
 * Resumen del workspace para la Vista general de Operaciones (issue #40).
 * Solo lee datos ya persistidos (último health check, contadores de uso, bitácora): nunca abre conexiones
 * externas, así responde en milisegundos. Cada combinación workspace/rol se cachea 60 s.
 */
@Injectable()
export class DashboardService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledReports: ScheduledReportsService,
    private readonly platformHealth: PlatformHealthService,
    @Optional() private readonly usageMeter?: UsageMeterService,
  ) {}

  async getSummary(actor: AuthenticatedUser, now: Date = new Date()): Promise<DashboardSummaryDto> {
    // La actividad depende del usuario cuando el rol no puede leer toda la bitácora.
    const key = [actor.workspaceId, actor.role, hasPermission(actor.role, 'READ_AUDIT') ? '*' : actor.id].join('|');
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now.getTime()) return cached.value;

    const value = this.buildSummary(actor, now);
    this.remember(key, { expiresAt: now.getTime() + DASHBOARD_CACHE_TTL_MS, value });
    // Un fallo no debe quedar cacheado.
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private remember(key: string, entry: CacheEntry): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, entry);
  }

  private async buildSummary(actor: AuthenticatedUser, now: Date): Promise<DashboardSummaryDto> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: actor.workspaceId },
      select: { zonaHoraria: true },
    });
    const timeZone = workspace && isValidTimeZone(workspace.zonaHoraria) ? workspace.zonaHoraria : 'UTC';
    const months = monthRanges(now, timeZone);

    const canViewConnections = hasPermission(actor.role, 'VIEW_CONNECTIONS');
    const canManageQueries = hasPermission(actor.role, 'MANAGE_QUERIES');
    const canRunQueries = hasPermission(actor.role, 'RUN_SAVED_QUERIES');

    const [connections, crossJoins, exports, dataProcessed, apiUsage, recentQueries, upcoming, activity, services] =
      await Promise.all([
        this.prisma.conexionDB.findMany({
          where: { workspaceId: actor.workspaceId },
          select: {
            id: true,
            nombre: true,
            tipoMotor: true,
            host: true,
            dbName: true,
            ultimoHealthStatus: true,
            ultimaLatenciaMs: true,
            ultimoHealthAt: true,
          },
        }),
        this.monthlyAudit(actor.workspaceId, 'EXECUTE_JOIN', months),
        this.monthlyAudit(actor.workspaceId, 'EXPORT', months),
        this.dataProcessed(actor.workspaceId, months),
        this.apiUsage(actor.workspaceId, now),
        canRunQueries
          ? this.prisma.savedQuery.findMany({
              where: { workspaceId: actor.workspaceId, ...(canManageQueries ? {} : { visibilidad: 'PUBLICADA' as const }) },
              select: { id: true, nombre: true, definicion: true, updatedAt: true, autor: { select: { name: true } } },
              orderBy: { updatedAt: 'desc' },
              take: RECENT_QUERIES,
            })
          : Promise.resolve(null),
        hasPermission(actor.role, 'MANAGE_REPORTS')
          ? this.scheduledReports.upcoming(actor.workspaceId, UPCOMING_REPORTS)
          : Promise.resolve(null),
        this.recentActivity(actor),
        this.platformHealth.check(),
      ]);

    const connectionsSummary = canViewConnections ? this.connectionsSummary(connections) : null;

    return {
      generadoEn: now.toISOString(),
      cacheHasta: new Date(now.getTime() + DASHBOARD_CACHE_TTL_MS).toISOString(),
      zonaHoraria: timeZone,
      periodo: {
        mes: months.current.key,
        inicio: months.current.start.toISOString(),
        fin: months.current.end.toISOString(),
      },
      conexiones: connectionsSummary,
      crossJoins: {
        mesActual: crossJoins.current,
        mesAnterior: crossJoins.previous,
        variacionPct: percentChange(crossJoins.current, crossJoins.previous),
        ultimaEjecucion: crossJoins.last?.toISOString() ?? null,
      },
      exportaciones: {
        mesActual: exports.current,
        mesAnterior: exports.previous,
        variacionPct: percentChange(exports.current, exports.previous),
      },
      datosProcesados: dataProcessed,
      consumoApi: apiUsage,
      consultasRecientes: recentQueries ? this.toRecentQueries(recentQueries, connections) : null,
      reportesProximos:
        upcoming?.map((report) => ({
          id: report.id,
          nombre: report.nombre,
          formato: report.formato,
          proximaEjecucion: report.nextRunAt,
        })) ?? null,
      actividadReciente: activity,
      entorno: this.environment(connectionsSummary, services),
    };
  }

  private connectionsSummary(connections: ConnectionRow[]): DashboardConnectionsDto {
    const threshold = getLatencyThresholdMs();
    const healthy = connections.filter((connection) => connection.ultimoHealthStatus === 'HEALTHY');
    const down = connections.filter((connection) => connection.ultimoHealthStatus === 'UNAVAILABLE');
    const lastCheck = connections
      .map((connection) => connection.ultimoHealthAt?.getTime() ?? 0)
      .reduce((latest, time) => Math.max(latest, time), 0);
    const label = (connection: ConnectionRow) => connection.nombre ?? `${connection.dbName} · ${connection.host}`;

    return {
      total: connections.length,
      activas: healthy.length,
      caidas: down.length,
      sinComprobar: connections.length - healthy.length - down.length,
      motoresConectados: [...new Set(healthy.map((connection) => connection.tipoMotor))].sort(),
      requierenAtencion: down.map((connection) => ({
        id: connection.id,
        nombre: label(connection),
        tipoMotor: connection.tipoMotor,
        estado: connection.ultimoHealthStatus ?? 'UNAVAILABLE',
        ultimoHealthAt: connection.ultimoHealthAt?.toISOString() ?? null,
      })),
      umbralLatenciaMs: threshold,
      latencias: healthy
        .filter((connection) => connection.ultimaLatenciaMs !== null && connection.ultimoHealthAt !== null)
        .sort((a, b) => a.ultimaLatenciaMs! - b.ultimaLatenciaMs!)
        .map((connection) => ({
          id: connection.id,
          nombre: label(connection),
          tipoMotor: connection.tipoMotor,
          latenciaMs: connection.ultimaLatenciaMs!,
          superaUmbral: connection.ultimaLatenciaMs! > threshold,
          ultimoHealthAt: connection.ultimoHealthAt!.toISOString(),
        })),
      ultimaComprobacion: lastCheck > 0 ? new Date(lastCheck).toISOString() : null,
    };
  }

  /** Eventos correctos de la bitácora en el mes actual y el anterior (índice workspaceId + createdAt). */
  private async monthlyAudit(
    workspaceId: string,
    eventType: 'EXECUTE_JOIN' | 'EXPORT',
    months: { current: MonthRange; previous: MonthRange },
  ): Promise<{ current: number; previous: number; last: Date | null }> {
    const where = (range: MonthRange): Prisma.RegistroAuditoriaWhereInput => ({
      workspaceId,
      eventType,
      outcome: 'SUCCESS',
      createdAt: { gte: range.start, lt: range.end },
    });
    const [current, previous, last] = await Promise.all([
      this.prisma.registroAuditoria.count({ where: where(months.current) }),
      this.prisma.registroAuditoria.count({ where: where(months.previous) }),
      eventType === 'EXECUTE_JOIN'
        ? this.prisma.registroAuditoria.findFirst({
            where: { workspaceId, eventType, outcome: 'SUCCESS' },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          })
        : Promise.resolve(null),
    ]);
    return { current, previous, last: last?.createdAt ?? null };
  }

  /** Los contadores de uso son diarios en UTC; el mes se toma por las fechas locales de inicio y fin. */
  private async dataProcessed(
    workspaceId: string,
    months: { current: MonthRange; previous: MonthRange },
  ): Promise<DataProcessedMetricDto> {
    const sum = async (range: MonthRange) => {
      const result = await this.prisma.workspaceUsageDaily.aggregate({
        where: { workspaceId, dia: { gte: utcDate(range.key, 1), lt: nextMonthDate(range.key) } },
        _sum: { bytesProcesados: true },
      });
      return Number(result._sum.bytesProcesados ?? 0n);
    };
    const pendingCurrent = (this.usageMeter?.pendingFor(workspaceId) ?? [])
      .filter((usage) => usage.day.startsWith(months.current.key))
      .reduce((total, usage) => total + usage.bytesProcessed, 0);
    const [current, previous] = await Promise.all([sum(months.current), sum(months.previous)]);
    const bytesMesActual = current + pendingCurrent;
    const limit = getDataLimitBytes();
    return {
      bytesMesActual,
      bytesMesAnterior: previous,
      variacionPct: percentChange(bytesMesActual, previous),
      limitePlanBytes: limit,
      usoPlanPct: Math.round((bytesMesActual / limit) * 1000) / 10,
    };
  }

  /** Solicitudes de los últimos 7 días y de los 7 anteriores, para la variación semanal. */
  private async apiUsage(workspaceId: string, now: Date): Promise<ApiUsageMetricDto> {
    const days = lastUtcDays(now, 14);
    const rows = await this.prisma.workspaceUsageDaily.findMany({
      where: { workspaceId, dia: { gte: new Date(`${days[0]}T00:00:00Z`) } },
      select: { dia: true, solicitudesApi: true },
    });
    const byDay = new Map(rows.map((row) => [row.dia.toISOString().slice(0, 10), row.solicitudesApi]));
    for (const pending of this.usageMeter?.pendingFor(workspaceId) ?? []) {
      byDay.set(pending.day, (byDay.get(pending.day) ?? 0) + pending.apiRequests);
    }
    const series = days.map((dia) => ({ dia, solicitudes: byDay.get(dia) ?? 0 }));
    const previousWeek = series.slice(0, 7).reduce((total, day) => total + day.solicitudes, 0);
    const week = series.slice(7);
    const totalSemana = week.reduce((total, day) => total + day.solicitudes, 0);
    return {
      dias: week,
      totalSemana,
      totalSemanaAnterior: previousWeek,
      variacionPct: percentChange(totalSemana, previousWeek),
    };
  }

  private async recentActivity(actor: AuthenticatedUser): Promise<RecentActivityDto[]> {
    const events = await this.prisma.registroAuditoria.findMany({
      where: {
        workspaceId: actor.workspaceId,
        ...(hasPermission(actor.role, 'READ_AUDIT') ? {} : { actorUserId: actor.id }),
      },
      select: { id: true, eventType: true, outcome: true, actorEmail: true, targetType: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: RECENT_ACTIVITY,
    });
    return events.map((event) => ({
      id: event.id,
      tipo: event.eventType,
      descripcion: ACTIVITY_LABELS[event.eventType] ?? event.eventType,
      resultado: event.outcome,
      actor: event.actorEmail,
      objetivo: event.targetType,
      fecha: event.createdAt.toISOString(),
    }));
  }

  private toRecentQueries(
    queries: { id: string; nombre: string; definicion: Prisma.JsonValue; updatedAt: Date; autor: { name: string } | null }[],
    connections: ConnectionRow[],
  ): RecentSavedQueryDto[] {
    const engineById = new Map(connections.map((connection) => [connection.id, connection.tipoMotor]));
    return queries.map((query) => ({
      id: query.id,
      nombre: query.nombre,
      fuentes: connectionIdsOf(query.definicion)
        .map((id) => engineById.get(id))
        .filter((engine): engine is string => engine !== undefined),
      autor: query.autor?.name ?? null,
      actualizadaEn: query.updatedAt.toISOString(),
    }));
  }

  private environment(
    connections: DashboardConnectionsDto | null,
    services: EnvironmentStatusDto['servicios'],
  ): EnvironmentStatusDto {
    const statuses = services.map((service) => service.estado);
    const estadoGeneral = statuses.includes('CAIDO')
      ? 'CAIDO'
      : statuses.includes('DEGRADADO')
        ? 'DEGRADADO'
        : 'OPERATIVO';
    return { conexionesConError: connections ? connections.caidas : null, servicios: services, estadoGeneral };
  }
}

/** Conexiones de una definición de join, en el orden en que aparecen (formato N fuentes o el original). */
function connectionIdsOf(definition: Prisma.JsonValue): string[] {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return [];
  const record = definition as Record<string, unknown>;
  const ids: string[] = [];
  if (Array.isArray(record.fuentes)) {
    for (const source of record.fuentes) {
      const id = (source as { conexionId?: unknown } | null)?.conexionId;
      if (typeof id === 'string') ids.push(id);
    }
  }
  for (const key of ['conexionSqlId', 'conexionNoSqlId']) {
    if (typeof record[key] === 'string') ids.push(record[key] as string);
  }
  return ids;
}

function utcDate(monthKey: string, day: number): Date {
  return new Date(`${monthKey}-${String(day).padStart(2, '0')}T00:00:00Z`);
}

function nextMonthDate(monthKey: string): Date {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
}
