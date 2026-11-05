import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AUDIT_EVENT_TYPES, type AuditEventType } from '../audit.types.js';

export class QueryAuditLogsDto {
  @ApiPropertyOptional({
    description: 'Número de página',
    default: 1,
    minimum: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Cantidad de registros por página',
    default: 50,
    minimum: 1,
    maximum: 100,
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional({
    description: 'Filtrar registros a partir de esta fecha (formato ISO 8601)',
    example: '2026-10-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString({}, { message: 'fechaInicio debe ser una fecha ISO 8601 válida' })
  fechaInicio?: string;

  @ApiPropertyOptional({
    description: 'Filtrar registros hasta esta fecha (formato ISO 8601)',
    example: '2026-10-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString({}, { message: 'fechaFin debe ser una fecha ISO 8601 válida' })
  fechaFin?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por tipo de acción o evento',
    enum: [...AUDIT_EVENT_TYPES],
    example: 'CONNECTION_DELETED',
  })
  @IsOptional()
  @IsIn([...AUDIT_EVENT_TYPES], {
    message: `tipoAccion debe ser uno de: ${AUDIT_EVENT_TYPES.join(', ')}`,
  })
  tipoAccion?: AuditEventType;
}
