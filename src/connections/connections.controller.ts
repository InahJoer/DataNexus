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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ConnectionsService } from './connections.service.js';
import { CreateConnectionDto } from './dto/create-connection.dto.js';
import { UpdateConnectionDto } from './dto/update-connection.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';

@ApiTags('Connections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear una conexión en el workspace autenticado' })
  @ApiResponse({ status: 201, description: 'Conexión creada; las credenciales no se devuelven.' })
  @ApiResponse({ status: 403, description: 'Solo ADMIN puede crear conexiones.' })
  create(@Req() request: AuthenticatedRequest, @Body() input: CreateConnectionDto) {
    return this.connectionsService.create(request.user, input, this.auditContext(request));
  }

  @Get()
  @ApiOperation({ summary: 'Listar conexiones del workspace autenticado' })
  @ApiResponse({ status: 200, description: 'Lista segura de conexiones.' })
  findAll(@Req() request: AuthenticatedRequest) {
    return this.connectionsService.findAll(request.user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener una conexión del workspace autenticado' })
  @ApiResponse({ status: 200, description: 'Detalle seguro de la conexión.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.connectionsService.findOne(request.user, id);
  }

  @Patch(':id')
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
