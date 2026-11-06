import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiOkResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConnectionsService } from './connections.service.js';
import { CreateConnectionDto } from './dto/create-connection.dto.js';
import { UpdateConnectionDto } from './dto/update-connection.dto.js';
import { ConnectionResponseDto } from './dto/connection-response.dto.js';
import { ConnectionTestOptionsDto, TestConnectionDto } from './dto/test-connection.dto.js';
import { ConnectionTestResultDto } from './dto/connection-test-result.dto.js';
import { ConnectionTestService } from './connection-test.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';

@ApiTags('Connections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly connectionsService: ConnectionsService,
    private readonly connectionTestService: ConnectionTestService,
  ) {}

  @Post()
  @RequirePermission('MANAGE_CONNECTIONS')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear una conexión en el workspace autenticado' })
  @ApiResponse({ status: 201, description: 'Conexión creada; las credenciales no se devuelven.' })
  @ApiResponse({ status: 403, description: 'Solo ADMIN puede crear conexiones.' })
  create(@Req() request: AuthenticatedRequest, @Body() input: CreateConnectionDto) {
    return this.connectionsService.create(request.user, input, this.auditContext(request));
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('test')
  @RequirePermission('MANAGE_CONNECTIONS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Probar credenciales antes de guardar la conexión (RF-10)',
    description:
      'Conecta, autentica y consulta la versión del servidor midiendo la latencia. No persiste nada ni devuelve secretos. ' +
      'Un fallo de red o credenciales responde 200 con ok=false y un error normalizado por motor.',
  })
  @ApiOkResponse({ type: ConnectionTestResultDto })
  @ApiResponse({ status: 400, description: 'Datos de conexión inválidos.' })
  @ApiResponse({ status: 403, description: 'Solo ADMIN puede probar credenciales nuevas.' })
  @ApiResponse({ status: 429, description: 'Máximo 10 pruebas por minuto.' })
  testCredentials(@Body() input: TestConnectionDto) {
    return this.connectionTestService.testCredentials(input);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post(':id/test')
  @RequirePermission('VIEW_CONNECTIONS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Probar una conexión guardada y medir su latencia (RF-10)',
    description:
      'Usa las credenciales cifradas de la conexión sin exponerlas. Un fallo de red o credenciales responde 200 con ok=false.',
  })
  @ApiBody({ type: ConnectionTestOptionsDto, required: false })
  @ApiOkResponse({ type: ConnectionTestResultDto })
  @ApiResponse({ status: 403, description: 'Se requiere rol ADMIN u OPERADOR.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  @ApiResponse({ status: 429, description: 'Máximo 10 pruebas por minuto.' })
  testSaved(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() options: ConnectionTestOptionsDto = {},
  ) {
    return this.connectionTestService.testSaved(request.user, id, options);
  }

  @Get()
  @RequirePermission('VIEW_CONNECTIONS')
  @ApiOperation({ summary: 'Listar conexiones del workspace autenticado (ADMIN u OPERADOR)' })
  @ApiOkResponse({ type: ConnectionResponseDto, isArray: true, description: 'Lista segura de conexiones.' })
  @ApiResponse({ status: 403, description: 'Se requiere rol ADMIN u OPERADOR para listar conexiones.' })
  findAll(@Req() request: AuthenticatedRequest) {
    return this.connectionsService.findAll(request.user);
  }

  @Get(':id')
  @RequirePermission('VIEW_CONNECTIONS')
  @ApiOperation({ summary: 'Obtener una conexión del workspace autenticado' })
  @ApiOkResponse({ type: ConnectionResponseDto, description: 'Detalle seguro de la conexión.' })
  @ApiResponse({ status: 403, description: 'Se requiere rol ADMIN u OPERADOR para consultar conexiones.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.connectionsService.findOne(request.user, id);
  }

  @Patch(':id')
  @RequirePermission('MANAGE_CONNECTIONS')
  @ApiOperation({ summary: 'Actualizar una conexión del workspace autenticado' })
  @ApiResponse({ status: 200, description: 'Conexión actualizada y cambio auditado.' })
  @ApiResponse({ status: 403, description: 'Solo ADMIN puede actualizar conexiones.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateConnectionDto,
  ) {
    return this.connectionsService.update(request.user, id, input, this.auditContext(request));
  }

  @Delete(':id')
  @RequirePermission('MANAGE_CONNECTIONS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar una conexión del workspace autenticado' })
  @ApiResponse({ status: 200, description: 'Conexión eliminada y acción auditada.' })
  @ApiResponse({ status: 403, description: 'Solo ADMIN puede eliminar conexiones.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.connectionsService.remove(request.user, id, this.auditContext(request));
  }

  private auditContext(request: AuthenticatedRequest) {
    return {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    };
  }
}
