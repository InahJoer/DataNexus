import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { RequirePermission } from '../../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../../auth/interfaces/authenticated-user.interface.js';
import { AuditService } from '../../audit/audit.service.js';
import { CreateSensitiveFieldDto } from './sensitive-fields.dto.js';
import { SensitiveFieldsService } from './sensitive-fields.service.js';

/** Campos sensibles del workspace (RF-20). Solo ADMINISTRADOR. */
@ApiTags('Workspace - Campos sensibles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('workspaces/me/sensitive-fields')
export class SensitiveFieldsController {
  constructor(
    private readonly fields: SensitiveFieldsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('MANAGE_WORKSPACE')
  @ApiOperation({ summary: 'Listar los campos marcados como sensibles' })
  @ApiOkResponse({ description: 'Reglas de enmascaramiento del workspace' })
  @ApiForbiddenResponse({ description: 'Solo ADMINISTRADOR.' })
  list(@Req() request: AuthenticatedRequest) {
    return this.fields.list(request.user);
  }

  @Post()
  @RequirePermission('MANAGE_WORKSPACE')
  @ApiOperation({
    summary: 'Marcar un campo como sensible',
    description:
      'Desde ese momento ningún rol sin VIEW_UNMASKED_DATA (LECTOR, AUDITOR) recibe su valor real en cross-joins, ' +
      'exportaciones, reportes programados, joins asíncronos ni exploración de datos.',
  })
  @ApiCreatedResponse({ description: 'Regla creada' })
  @ApiNotFoundResponse({ description: 'La conexión no pertenece al workspace.' })
  @ApiConflictResponse({ description: 'Ya existe una regla igual.' })
  async create(@Req() request: AuthenticatedRequest, @Body() dto: CreateSensitiveFieldDto) {
    const field = await this.fields.create(request.user, dto);
    await this.record(request, null, `${field.campo} (${field.estrategia}${field.entidad ? ', ' + field.entidad : ''})`);
    return field;
  }

  @Delete(':id')
  @RequirePermission('MANAGE_WORKSPACE')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitar un campo sensible' })
  @ApiNoContentResponse({ description: 'Regla eliminada' })
  @ApiNotFoundResponse({ description: 'Regla inexistente o de otro workspace.' })
  async remove(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    await this.fields.remove(request.user, id);
    await this.record(request, `regla ${id}`, null);
  }

  /** Cambiar qué se enmascara es una decisión de seguridad: queda en la bitácora. */
  private record(request: AuthenticatedRequest, antes: string | null, despues: string | null) {
    return this.audit.record({
      eventType: 'WORKSPACE_UPDATED',
      outcome: 'SUCCESS',
      actorUserId: request.user.id,
      actorEmail: request.user.email,
      workspaceId: request.user.workspaceId,
      targetType: 'WORKSPACE',
      targetId: request.user.workspaceId,
      details: { campos: ['camposSensibles'], cambios: { camposSensibles: { antes, despues } } },
      ipAddress: request.ip,
      userAgent: request.get?.('user-agent') ?? undefined,
    });
  }
}
