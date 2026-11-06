import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const PLATFORM_SERVICE_STATUSES = ['OPERATIVO', 'DEGRADADO', 'CAIDO', 'NO_CONFIGURADO'] as const;
export type PlatformServiceStatus = (typeof PLATFORM_SERVICE_STATUSES)[number];

export class DashboardPeriodDto {
  @ApiProperty({ example: '2026-11' })
  mes: string;

  @ApiProperty({ format: 'date-time', description: 'Inicio del mes en la zona horaria del workspace.' })
  inicio: string;

  @ApiProperty({ format: 'date-time', description: 'Inicio del mes siguiente (exclusivo).' })
  fin: string;
}

export class ConnectionAttentionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'CRM Legado' })
  nombre: string;

  @ApiProperty({ example: 'SQLSERVER' })
  tipoMotor: string;

  @ApiProperty({ example: 'UNAVAILABLE', description: 'Resultado del último health check.' })
  estado: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  ultimoHealthAt: string | null;
}

export class ConnectionLatencyDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ERP Producción' })
  nombre: string;

  @ApiProperty({ example: 'POSTGRESQL' })
  tipoMotor: string;

  @ApiProperty({ example: 24 })
  latenciaMs: number;

  @ApiProperty({ description: 'true si supera el umbral configurado.' })
  superaUmbral: boolean;

  @ApiProperty({ format: 'date-time' })
  ultimoHealthAt: string;
}

export class DashboardConnectionsDto {
  @ApiProperty({ example: 13 })
  total: number;

  @ApiProperty({ example: 12, description: 'Conexiones cuyo último health check fue correcto.' })
  activas: number;

  @ApiProperty({ example: 1, description: 'Conexiones cuyo último health check falló.' })
  caidas: number;

  @ApiProperty({ example: 0, description: 'Conexiones nunca comprobadas o con motor sin health check.' })
  sinComprobar: number;

  @ApiProperty({ type: [String], example: ['POSTGRESQL', 'SQLSERVER', 'FIRESTORE'], description: 'Motores con al menos una conexión activa.' })
  motoresConectados: string[];

  @ApiProperty({ type: [ConnectionAttentionDto], description: 'Conexiones que requieren atención (último health check fallido).' })
  requierenAtencion: ConnectionAttentionDto[];

  @ApiProperty({ example: 100, description: 'Umbral de latencia (CONNECTION_LATENCY_THRESHOLD_MS).' })
  umbralLatenciaMs: number;

  @ApiProperty({ type: [ConnectionLatencyDto], description: 'Latencia del último health check correcto, de menor a mayor.' })
  latencias: ConnectionLatencyDto[];

  @ApiPropertyOptional({ format: 'date-time', nullable: true, description: 'Health check más reciente del workspace.' })
  ultimaComprobacion: string | null;
}

export class MonthlyCountDto {
  @ApiProperty({ example: 1284 })
  mesActual: number;

  @ApiProperty({ example: 1083 })
  mesAnterior: number;

  @ApiPropertyOptional({ nullable: true, example: 18.6, description: 'Variación % respecto al mes anterior; null si no hubo actividad.' })
  variacionPct: number | null;
}

export class CrossJoinsMetricDto extends MonthlyCountDto {
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  ultimaEjecucion: string | null;
}

export class DataProcessedMetricDto {
  @ApiProperty({ example: 904_727_658_496, description: 'Bytes extraídos de las fuentes este mes (joins, exportaciones y reportes).' })
  bytesMesActual: number;

  @ApiProperty({ example: 804_727_658_496 })
  bytesMesAnterior: number;

  @ApiPropertyOptional({ nullable: true, example: 12.4 })
  variacionPct: number | null;

  @ApiProperty({ example: 1_099_511_627_776, description: 'Límite del plan en bytes (WORKSPACE_DATA_LIMIT_GB).' })
  limitePlanBytes: number;

  @ApiProperty({ example: 82.3, description: 'Porcentaje del plan usado este mes.' })
  usoPlanPct: number;
}

export class ApiUsageDayDto {
  @ApiProperty({ example: '2026-11-06', description: 'Día en UTC.' })
  dia: string;

  @ApiProperty({ example: 18234 })
  solicitudes: number;
}

export class ApiUsageMetricDto {
  @ApiProperty({ type: [ApiUsageDayDto], description: 'Últimos 7 días, del más antiguo a hoy.' })
  dias: ApiUsageDayDto[];

  @ApiProperty({ example: 124806 })
  totalSemana: number;

  @ApiProperty({ example: 115348 })
  totalSemanaAnterior: number;

  @ApiPropertyOptional({ nullable: true, example: 8.2 })
  variacionPct: number | null;
}

export class RecentSavedQueryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ventas y eventos por cliente' })
  nombre: string;

  @ApiProperty({ type: [String], example: ['SQLSERVER', 'FIRESTORE'], description: 'Motores de las fuentes, en orden.' })
  fuentes: string[];

  @ApiPropertyOptional({ nullable: true, example: 'Ana Martínez' })
  autor: string | null;

  @ApiProperty({ format: 'date-time' })
  actualizadaEn: string;
}

export class UpcomingReportDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ventas diarias' })
  nombre: string;

  @ApiProperty({ example: 'pdf' })
  formato: string;

  @ApiProperty({ format: 'date-time' })
  proximaEjecucion: string;
}

export class RecentActivityDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'EXECUTE_JOIN' })
  tipo: string;

  @ApiProperty({ example: 'Ejecutó un Cross-Join' })
  descripcion: string;

  @ApiProperty({ enum: ['SUCCESS', 'FAILURE'] })
  resultado: string;

  @ApiPropertyOptional({ nullable: true, example: 'ana@acme.com' })
  actor: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'CROSS_JOIN' })
  objetivo: string | null;

  @ApiProperty({ format: 'date-time' })
  fecha: string;
}

export class PlatformServiceDto {
  @ApiProperty({ example: 'Base de datos' })
  servicio: string;

  @ApiProperty({ enum: PLATFORM_SERVICE_STATUSES })
  estado: PlatformServiceStatus;

  @ApiProperty({ example: 'PostgreSQL responde' })
  detalle: string;

  @ApiPropertyOptional({ nullable: true, example: 3 })
  latenciaMs: number | null;
}

export class EnvironmentStatusDto {
  @ApiPropertyOptional({ nullable: true, example: 1, description: 'null si el rol no puede ver conexiones.' })
  conexionesConError: number | null;

  @ApiProperty({ type: [PlatformServiceDto] })
  servicios: PlatformServiceDto[];

  @ApiProperty({ enum: ['OPERATIVO', 'DEGRADADO', 'CAIDO'], description: 'Peor estado entre los servicios configurados.' })
  estadoGeneral: Exclude<PlatformServiceStatus, 'NO_CONFIGURADO'>;
}

/** Resumen del workspace para la Vista general de Operaciones (issue #40). Las secciones null no aplican al rol. */
export class DashboardSummaryDto {
  @ApiProperty({ format: 'date-time' })
  generadoEn: string;

  @ApiProperty({ format: 'date-time', description: 'Hasta cuándo se sirve esta respuesta desde la caché (60 s).' })
  cacheHasta: string;

  @ApiProperty({ example: 'America/Managua' })
  zonaHoraria: string;

  @ApiProperty({ type: DashboardPeriodDto })
  periodo: DashboardPeriodDto;

  @ApiPropertyOptional({ type: DashboardConnectionsDto, nullable: true, description: 'Solo ADMIN y OPERADOR.' })
  conexiones: DashboardConnectionsDto | null;

  @ApiProperty({ type: CrossJoinsMetricDto })
  crossJoins: CrossJoinsMetricDto;

  @ApiProperty({ type: MonthlyCountDto })
  exportaciones: MonthlyCountDto;

  @ApiProperty({ type: DataProcessedMetricDto })
  datosProcesados: DataProcessedMetricDto;

  @ApiProperty({ type: ApiUsageMetricDto })
  consumoApi: ApiUsageMetricDto;

  @ApiPropertyOptional({ type: [RecentSavedQueryDto], nullable: true, description: 'El LECTOR solo ve las publicadas; null para AUDITOR.' })
  consultasRecientes: RecentSavedQueryDto[] | null;

  @ApiPropertyOptional({ type: [UpcomingReportDto], nullable: true, description: 'Solo ADMIN y OPERADOR.' })
  reportesProximos: UpcomingReportDto[] | null;

  @ApiProperty({ type: [RecentActivityDto], description: 'ADMIN y AUDITOR ven todo el workspace; el resto, su propia actividad.' })
  actividadReciente: RecentActivityDto[];

  @ApiProperty({ type: EnvironmentStatusDto })
  entorno: EnvironmentStatusDto;
}
