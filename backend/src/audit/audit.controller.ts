import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { AuditService, MAX_AUDIT_EXPORT_ROWS } from './audit.service.js';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto.js';
import { ExportAuditLogsDto } from './dto/export-audit-logs.dto.js';
import { PaginatedAuditLogsResponseDto } from './dto/audit-log-response.dto.js';

@ApiTags('Audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @RequirePermission('READ_AUDIT')
  @Get('logs')
  @ApiOperation({
    summary: 'Consultar logs de auditoría con paginación y filtros',
    description:
      'Obtiene los registros de auditoría del workspace con paginación nativa (?page=1&limit=50) y filtros opcionales por fechaInicio, fechaFin y tipoAccion. Requiere rol ADMIN o AUDITOR.',
  })
  @ApiOkResponse({ type: PaginatedAuditLogsResponseDto, description: 'Listado paginado de logs de auditoría.' })
  @ApiForbiddenResponse({
    description: 'Se requiere rol ADMIN o AUDITOR para consultar los logs de auditoría.',
  })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  findAll(@Req() request: AuthenticatedRequest, @Query() query: QueryAuditLogsDto) {
    return this.auditService.findAll(request.user, query);
  }

  @Throttle({ export: { limit: 20, ttl: 60000 } })
  @RequirePermission('READ_AUDIT')
  @Get('logs/export')
  @ApiOperation({
    summary: 'Exportar la bitácora filtrada a CSV o JSON',
    description: `Descarga los registros del workspace con los mismos filtros que /audit/logs (máximo ${MAX_AUDIT_EXPORT_ROWS} por archivo). La exportación queda registrada como AUDIT_LOG_EXPORTED. Requiere rol ADMIN o AUDITOR.`,
  })
  @ApiProduces('text/csv', 'application/json')
  @ApiOkResponse({
    description:
      'Archivo descargable. El encabezado X-Audit-Export-Truncated vale "true" si había más registros que el máximo.',
  })
  @ApiBadRequestResponse({ description: 'Formato o filtros inválidos.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN o AUDITOR para exportar la bitácora.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  async exportLogs(
    @Req() request: AuthenticatedRequest,
    @Query() query: ExportAuditLogsDto,
    @Res() res: Response,
  ) {
    const result = await this.auditService.exportLogs(request.user, query, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });

    res.set({
      'Content-Type': result.contentType,
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Length': String(result.buffer.length),
      'X-Audit-Export-Truncated': String(result.truncated),
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Audit-Export-Truncated',
    });
    res.end(result.buffer);
  }
}
