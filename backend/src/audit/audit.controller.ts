import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { AuditService } from './audit.service.js';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto.js';
import { PaginatedAuditLogsResponseDto } from './dto/audit-log-response.dto.js';

@ApiTags('Audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Roles('ADMIN')
  @Get('logs')
  @ApiOperation({
    summary: 'Consultar logs de auditoría con paginación y filtros',
    description:
      'Obtiene los registros de auditoría del workspace con paginación nativa (?page=1&limit=50) y filtros opcionales por fechaInicio, fechaFin y tipoAccion. Requiere rol ADMIN.',
  })
  @ApiOkResponse({ type: PaginatedAuditLogsResponseDto, description: 'Listado paginado de logs de auditoría.' })
  @ApiForbiddenResponse({
    description: 'Se requiere rol ADMIN para consultar los logs de auditoría.',
  })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  findAll(@Req() request: AuthenticatedRequest, @Query() query: QueryAuditLogsDto) {
    return this.auditService.findAll(request.user, query);
  }
}
