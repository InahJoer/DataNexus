import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ConnectionsService } from './connections.service.js';
import { CreateConnectionDto } from './dto/create-connection.dto.js';
import { UpdateConnectionDto } from './dto/update-connection.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';

@ApiTags('Connections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Crear nueva conexión a base de datos',
    description:
      'Recibe credenciales en texto plano, las encripta con AES-256 (RNF-01) y almacena el resultado en connectionStringEncriptada.',
  })
  @ApiResponse({
    status: 201,
    description: 'Conexión creada exitosamente con credenciales encriptadas.',
  })
  @ApiResponse({
    status: 400,
    description: 'Datos de entrada inválidos.',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado / Token JWT no provisto o inválido.',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace no encontrado.',
  })
  create(@Body() createConnectionDto: CreateConnectionDto) {
    return this.connectionsService.create(createConnectionDto);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar conexiones registradas',
    description: 'Retorna todas las conexiones o filtra por workspaceId si se provee en la query.',
  })
  @ApiQuery({
    name: 'workspaceId',
    required: false,
    description: 'Filtrar conexiones por UUID de Workspace',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de conexiones obtenida.',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado.',
  })
  findAll(@Query('workspaceId') workspaceId?: string) {
    return this.connectionsService.findAll(workspaceId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtener conexión por ID',
    description: 'Retorna los datos de una conexión específica.',
  })
  @ApiResponse({
    status: 200,
    description: 'Detalle de la conexión.',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado.',
  })
  @ApiResponse({
    status: 404,
    description: 'Conexión no encontrada.',
  })
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.connectionsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Actualizar conexión',
    description:
      'Permite actualizar metadata o la connectionString (que será nuevamente encriptada con AES-256).',
  })
  @ApiResponse({
    status: 200,
    description: 'Conexión actualizada exitosamente.',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado.',
  })
  @ApiResponse({
    status: 404,
    description: 'Conexión o Workspace no encontrado.',
  })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() updateConnectionDto: UpdateConnectionDto,
  ) {
    return this.connectionsService.update(id, updateConnectionDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Eliminar conexión',
    description: 'Elimina permanentemente una conexión por su ID.',
  })
  @ApiResponse({
    status: 200,
    description: 'Conexión eliminada exitosamente.',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado.',
  })
  @ApiResponse({
    status: 404,
    description: 'Conexión no encontrada.',
  })
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.connectionsService.remove(id);
  }

  @Get(':id/decrypted')
  @ApiOperation({
    summary: 'Obtener conexión con credenciales desencriptadas',
    description:
      'Desencripta con AES-256 la connectionString almacenada. Exclusivo para motores de procesamiento interno.',
  })
  @ApiResponse({
    status: 200,
    description: 'Conexión con credenciales desencriptadas.',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado.',
  })
  @ApiResponse({
    status: 404,
    description: 'Conexión no encontrada.',
  })
  getDecrypted(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.connectionsService.getDecrypted(id);
  }
}
