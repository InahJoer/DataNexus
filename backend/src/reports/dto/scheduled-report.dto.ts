import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const SCHEDULED_REPORT_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ScheduledReportFrequencyDto = (typeof SCHEDULED_REPORT_FREQUENCIES)[number];

export const SCHEDULED_REPORT_FORMATS = ['excel', 'pdf', 'json', 'word'] as const;
export type ScheduledReportFormatDto = (typeof SCHEDULED_REPORT_FORMATS)[number];

export const SCHEDULED_REPORT_STATUSES = ['ACTIVE', 'PAUSED', 'ERROR'] as const;
export type ScheduledReportStatusDto = (typeof SCHEDULED_REPORT_STATUSES)[number];

export class CreateScheduledReportDto {
  @ApiProperty({ format: 'uuid', description: 'Consulta guardada que se ejecutará.' })
  @IsUUID('4')
  savedQueryId: string;

  @ApiProperty({ example: 'Ventas semanales', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  reportTitle: string;

  @ApiProperty({ enum: SCHEDULED_REPORT_FREQUENCIES, example: 'weekly' })
  @IsIn(SCHEDULED_REPORT_FREQUENCIES)
  frequency: ScheduledReportFrequencyDto;

  @ApiProperty({ example: '08:30', description: 'Hora local en formato HH:mm.' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  time: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 6, description: 'Día semanal: 0 domingo, 6 sábado.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 28, description: 'Día del mes.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  dayOfMonth?: number;

  @ApiPropertyOptional({ example: 'America/Managua', description: 'Zona IANA; por defecto la del workspace.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;

  @ApiProperty({ enum: SCHEDULED_REPORT_FORMATS, example: 'excel' })
  @IsIn(SCHEDULED_REPORT_FORMATS)
  format: ScheduledReportFormatDto;

  @ApiPropertyOptional({ type: [String], example: ['analista@empresa.com'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  recipients?: string[];

  @ApiPropertyOptional({ default: true, description: 'Envía un enlace firmado al terminar.' })
  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean;
}

export class UpdateScheduledReportDto extends PartialType(CreateScheduledReportDto) {}

export class ScheduledReportResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  savedQueryId: string;

  @ApiProperty()
  savedQueryName: string;

  @ApiProperty()
  reportTitle: string;

  @ApiProperty({ enum: SCHEDULED_REPORT_FREQUENCIES })
  frequency: ScheduledReportFrequencyDto;

  @ApiProperty({ example: '08:30' })
  time: string;

  @ApiPropertyOptional({ nullable: true })
  dayOfWeek: number | null;

  @ApiPropertyOptional({ nullable: true })
  dayOfMonth: number | null;

  @ApiProperty()
  timezone: string;

  @ApiProperty({ example: '30 8 * * 1' })
  cronExpression: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  nextRunAt: string | null;

  @ApiProperty({ enum: SCHEDULED_REPORT_FORMATS })
  format: ScheduledReportFormatDto;

  @ApiProperty({ type: [String] })
  recipients: string[];

  @ApiProperty()
  sendEmail: boolean;

  @ApiProperty({ enum: SCHEDULED_REPORT_STATUSES })
  status: ScheduledReportStatusDto;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  lastRunAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  lastError: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

export class ScheduledReportsSummaryDto {
  @ApiProperty()
  active: number;

  @ApiProperty()
  paused: number;

  @ApiProperty()
  error: number;

  @ApiProperty()
  executionsToday: number;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  nextExecutionAt: string | null;
}

export const REPORT_EXECUTION_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export const REPORT_EXECUTION_TRIGGERS = ['SCHEDULED', 'MANUAL', 'ON_DEMAND'] as const;
export type ReportExecutionStatusDto = (typeof REPORT_EXECUTION_STATUSES)[number];
export type ReportExecutionTriggerDto = (typeof REPORT_EXECUTION_TRIGGERS)[number];

/** Una ejecución del historial de reportes (issue #39). Nunca incluye filas del reporte. */
export class ReportExecutionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'null en reportes bajo demanda.' })
  scheduledReportId: string | null;

  @ApiProperty({
    enum: REPORT_EXECUTION_TRIGGERS,
    description: 'SCHEDULED: horario; MANUAL: "Ejecutar ahora"; ON_DEMAND: POST /reports/trigger.',
  })
  trigger: ReportExecutionTriggerDto;

  @ApiProperty({ enum: REPORT_EXECUTION_STATUSES, description: 'RUNNING incluye los reintentos en curso.' })
  status: ReportExecutionStatusDto;

  @ApiPropertyOptional({ nullable: true, example: 'Ventas diarias' })
  titulo: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'pdf' })
  formato: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  scheduledFor: Date | null;

  @ApiProperty({ format: 'date-time' })
  startedAt: Date;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  finishedAt: Date | null;

  @ApiPropertyOptional({ nullable: true, example: 2350, description: 'Duración total en milisegundos, con reintentos.' })
  durationMs: number | null;

  @ApiProperty({ example: 1, description: 'Intentos realizados (1 = sin reintentos).' })
  attempts: number;

  @ApiPropertyOptional({ nullable: true })
  totalRows: number | null;

  @ApiPropertyOptional({ nullable: true, example: 48213, description: 'Tamaño del archivo en bytes.' })
  fileSizeBytes: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Mensaje seguro, sin datos de conexión.' })
  error: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Solo mientras el enlace no haya vencido.' })
  downloadUrl: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  expiresAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  messageId: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true, description: 'Cuándo se avisó del fallo al autor.' })
  authorNotifiedAt: Date | null;
}

/** @deprecated Usar ReportExecutionResponseDto. Se mantiene por compatibilidad con la issue #38. */
export class ScheduledReportRunResponseDto extends ReportExecutionResponseDto {}

export class ListReportExecutionsQueryDto {
  @ApiPropertyOptional({ enum: REPORT_EXECUTION_STATUSES })
  @IsOptional()
  @IsIn(REPORT_EXECUTION_STATUSES, { message: 'status debe ser RUNNING, SUCCEEDED o FAILED' })
  status?: ReportExecutionStatusDto;

  @ApiPropertyOptional({ enum: REPORT_EXECUTION_TRIGGERS })
  @IsOptional()
  @IsIn(REPORT_EXECUTION_TRIGGERS, { message: 'trigger debe ser SCHEDULED, MANUAL u ON_DEMAND' })
  trigger?: ReportExecutionTriggerDto;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
