import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { buildDataAccessAuditEvent } from '../data-engine/data-access-audit.js';
import type { CrossJoinDto } from '../data-engine/dto/cross-join.dto.js';
import {
  CreateSavedQueryDto,
  ListSavedQueriesQueryDto,
  RunSavedQueryDto,
  SavedQueryResponseDto,
  SavedQueryRunResultDto,
  SavedQueryVersionDto,
  UpdateSavedQueryDto,
} from './dto/saved-query.dto.js';
import { SavedQueriesService, type PreparedSavedQueryRun } from './saved-queries.service.js';

const UUID_PIPE = new ParseUUIDPipe({ version: '4' });

@ApiTags('Consultas guardadas')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('queries')
export class SavedQueriesController {
  constructor(
    private readonly savedQueries: SavedQueriesService,
    private readonly auditService: AuditService,
  ) {}

  @Post()
  @RequirePermission('MANAGE_QUERIES')
  @ApiOperation({
    summary: 'Guardar una consulta (vista unificada) del Query Builder',
    description: 'La definición es el cuerpo de POST /engine/join; se guarda como versión 1.',
  })
  @ApiCreatedResponse({ type: SavedQueryResponseDto })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR.' })
  @ApiNotFoundResponse({ description: 'Alguna conexión no existe en el workspace.' })
  @ApiConflictResponse({ description: 'Ya existe una consulta con ese nombre.' })
  create(@Req() request: AuthenticatedRequest, @Body() input: CreateSavedQueryDto) {
    return this.savedQueries.create(request.user, input, this.auditContext(request));
  }

  @Get()
  @RequirePermission('RUN_SAVED_QUERIES')
  @ApiOperation({
    summary: 'Listar consultas guardadas del workspace',
    description: 'ADMIN y OPERADOR ven todas; el LECTOR solo las publicadas y sin su definición.',
  })
  @ApiOkResponse({ type: SavedQueryResponseDto, isArray: true })
  @ApiForbiddenResponse({ description: 'El AUDITOR no accede a datos de negocio.' })
  findAll(@Req() request: AuthenticatedRequest, @Query() filters: ListSavedQueriesQueryDto) {
    return this.savedQueries.findAll(request.user, filters);
  }

  @Get(':id')
  @RequirePermission('RUN_SAVED_QUERIES')
  @ApiOperation({ summary: 'Obtener una consulta guardada' })
  @ApiOkResponse({ type: SavedQueryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o no es visible para el rol.' })
  findOne(@Req() request: AuthenticatedRequest, @Param('id', UUID_PIPE) id: string) {
    return this.savedQueries.findOne(request.user, id);
  }

  @Patch(':id')
  @RequirePermission('MANAGE_QUERIES')
  @ApiOperation({
    summary: 'Actualizar una consulta guardada',
    description: 'Solo el autor o un ADMIN. Si cambia la definición se crea una versión nueva.',
  })
  @ApiOkResponse({ type: SavedQueryResponseDto })
  @ApiForbiddenResponse({ description: 'Solo el autor o un ADMIN puede modificarla.' })
  @ApiNotFoundResponse({ description: 'Consulta o conexión no encontrada.' })
  @ApiConflictResponse({ description: 'Ya existe una consulta con ese nombre.' })
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', UUID_PIPE) id: string,
    @Body() input: UpdateSavedQueryDto,
  ) {
    return this.savedQueries.update(request.user, id, input, this.auditContext(request));
  }

  @Delete(':id')
  @RequirePermission('MANAGE_QUERIES')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar una consulta guardada y su historial de versiones' })
  @ApiForbiddenResponse({ description: 'Solo el autor o un ADMIN puede eliminarla.' })
  @ApiNotFoundResponse({ description: 'Consulta no encontrada.' })
  remove(@Req() request: AuthenticatedRequest, @Param('id', UUID_PIPE) id: string) {
    return this.savedQueries.remove(request.user, id, this.auditContext(request));
  }

  @Get(':id/versions')
  @RequirePermission('MANAGE_QUERIES')
  @ApiOperation({ summary: 'Historial de versiones de la definición' })
  @ApiOkResponse({ type: SavedQueryVersionDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Consulta no encontrada.' })
  listVersions(@Req() request: AuthenticatedRequest, @Param('id', UUID_PIPE) id: string) {
    return this.savedQueries.listVersions(request.user, id);
  }

  @Post(':id/run')
  @RequirePermission('RUN_SAVED_QUERIES')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ejecutar una consulta guardada',
    description:
      'Ejecuta la definición con el mismo motor que POST /engine/join (límites, filtros y enmascaramiento por rol). ' +
      'El LECTOR solo puede ejecutar consultas publicadas. Se registra como EXECUTE_JOIN en la bitácora.',
  })
  @ApiBody({ type: RunSavedQueryDto, required: false })
  @ApiOkResponse({ type: SavedQueryRunResultDto })
  @ApiNotFoundResponse({ description: 'Consulta, versión o conexión no encontrada.' })
  @ApiUnprocessableEntityResponse({ description: 'La definición guardada ya no es válida.' })
  @ApiBadGatewayResponse({ description: 'Falló la extracción de una fuente externa.' })
  @ApiGatewayTimeoutResponse({ description: 'La consulta a una fuente externa agotó el tiempo.' })
  @ApiPayloadTooLargeResponse({ description: 'El origen o el resultado supera los límites configurados.' })
  async run(
    @Req() request: AuthenticatedRequest,
    @Param('id', UUID_PIPE) id: string,
    @Body() options: RunSavedQueryDto = {},
  ) {
    const prepared = await this.savedQueries.prepareRun(request.user, id, options);
    try {
      const result = await this.savedQueries.execute(request.user, prepared);
      await this.auditService.record(this.runAuditEvent(request, prepared, { totalFilas: result.total }));
      return result;
    } catch (error) {
      try {
        await this.auditService.record(this.runAuditEvent(request, prepared, { error }));
      } catch {
        // El error de negocio original es el que debe llegar al cliente.
      }
      throw error;
    }
  }

  /** Mismo evento EXECUTE_JOIN que POST /engine/join, con la consulta y versión de origen. */
  private runAuditEvent(
    request: AuthenticatedRequest,
    prepared: PreparedSavedQueryRun,
    result: { totalFilas?: number; error?: unknown },
  ) {
    const event = buildDataAccessAuditEvent('EXECUTE_JOIN', request, prepared.payload as CrossJoinDto, result);
    return {
      ...event,
      details: {
        ...event.details,
        consultaGuardadaId: prepared.query.id,
        consultaGuardada: prepared.query.nombre,
        version: prepared.version,
      },
    };
  }

  private auditContext(request: AuthenticatedRequest) {
    return { ipAddress: request.ip, userAgent: request.get('user-agent') };
  }
}
