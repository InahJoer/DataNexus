import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { QueryAuditLogsDto } from './query-audit-logs.dto.js';

export const AUDIT_EXPORT_FORMATS = ['csv', 'json'] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

/** Mismos filtros que la consulta paginada (sin page/limit) más el formato del archivo. */
export class ExportAuditLogsDto extends PickType(QueryAuditLogsDto, [
  'fechaInicio',
  'fechaFin',
  'tipoAccion',
] as const) {
  @ApiPropertyOptional({ enum: [...AUDIT_EXPORT_FORMATS], default: 'csv' })
  @IsOptional()
  @IsIn([...AUDIT_EXPORT_FORMATS], { message: 'format debe ser csv o json' })
  format?: AuditExportFormat = 'csv';
}
