import { ApiProperty } from '@nestjs/swagger';

export class AuditLogEntryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'CONNECTION_CREATED' })
  eventType: string;

  @ApiProperty({ enum: ['SUCCESS', 'FAILURE'] })
  outcome: 'SUCCESS' | 'FAILURE';

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorUserId: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'admin@datanexus.io' })
  actorEmail: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  workspaceId: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'CONNECTION' })
  targetType: string | null;

  @ApiProperty({ type: String, nullable: true })
  targetId: string | null;

  @ApiProperty({ type: String, nullable: true, example: '{"tipoMotor":"SQLSERVER"}' })
  detailsJson: string | null;

  @ApiProperty({ type: String, nullable: true })
  ipAddress: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ enum: ['BAJO', 'MEDIO', 'ALTO'], description: 'Impacto derivado del tipo de evento' })
  impacto: 'BAJO' | 'MEDIO' | 'ALTO';
}

export class PaginatedAuditLogsResponseDto {
  @ApiProperty({ example: 129, minimum: 0 })
  total: number;

  @ApiProperty({ example: 1, minimum: 1 })
  page: number;

  @ApiProperty({ example: 50, minimum: 1, maximum: 100 })
  limit: number;

  @ApiProperty({ example: 3, minimum: 0 })
  totalPages: number;

  @ApiProperty({ type: [AuditLogEntryResponseDto] })
  data: AuditLogEntryResponseDto[];
}

export class AuditImpactCountsDto {
  @ApiProperty({ example: 900 })
  BAJO: number;

  @ApiProperty({ example: 350 })
  MEDIO: number;

  @ApiProperty({ example: 34 })
  ALTO: number;
}

export class AuditSummaryResponseDto {
  @ApiProperty({ example: 30, description: 'Días del período' })
  dias: number;

  @ApiProperty({ type: String, format: 'date-time' })
  desde: string;

  @ApiProperty({ example: 1284 })
  eventos: number;

  @ApiProperty({ example: 12, description: 'Usuarios distintos con actividad en el período' })
  usuariosActivos: number;

  @ApiProperty({ example: 7, description: 'Eventos con resultado FAILURE' })
  fallos: number;

  @ApiProperty({ type: AuditImpactCountsDto })
  porImpacto: AuditImpactCountsDto;

  @ApiProperty({ example: 365, description: 'Días que se conservan los registros (AUDIT_RETENTION_DAYS)' })
  retencionDias: number;
}
