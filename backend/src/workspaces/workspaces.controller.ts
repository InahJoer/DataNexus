import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto.js';
import { WorkspaceResponseDto, WorkspaceStatsDto } from './dto/workspace-response.dto.js';
import { WorkspacesService } from './workspaces.service.js';

@ApiTags('Workspaces')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Obtener el workspace del usuario autenticado',
    description:
      'Disponible para cualquier rol. La configuración (dominios permitidos y campos sensibles) solo se incluye para ADMIN.',
  })
  @ApiOkResponse({ type: WorkspaceResponseDto })
  @ApiNotFoundResponse({ description: 'El workspace del token ya no existe.' })
  findMine(@Req() request: AuthenticatedRequest) {
    return this.workspacesService.findMine(request.user);
  }

  @RequirePermission('MANAGE_WORKSPACE')
  @Patch('me')
  @ApiOperation({
    summary: 'Actualizar el workspace (ADMIN)',
    description:
      'Cambia nombre, logo, zona horaria, dominios permitidos y campos sensibles por defecto. Registra WORKSPACE_UPDATED con el antes y el después.',
  })
  @ApiOkResponse({ type: WorkspaceResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o ningún campo a modificar.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN.' })
  updateMine(@Req() request: AuthenticatedRequest, @Body() dto: UpdateWorkspaceDto) {
    return this.workspacesService.updateMine(request.user, dto, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });
  }

  @Get('me/stats')
  @ApiOperation({
    summary: 'Estadísticas del workspace',
    description: 'Número de miembros por rol, conexiones por motor y reportes enviados. Disponible para cualquier rol.',
  })
  @ApiOkResponse({ type: WorkspaceStatsDto })
  getStats(@Req() request: AuthenticatedRequest) {
    return this.workspacesService.getStats(request.user);
  }
}
