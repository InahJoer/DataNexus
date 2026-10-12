import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiGatewayTimeoutResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { DataEngineService } from './data-engine.service.js';

@ApiTags('Data Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('data-engine')
export class DataEngineController {
  constructor(private readonly dataEngineService: DataEngineService) {}

  @Get('connections/:connectionId/schema')
  @ApiOperation({
    summary: 'Explorar tablas, vistas o colecciones de una conexión propia',
    description:
      'Devuelve solo metadatos del catálogo externo. No incluye credenciales ni filas/documentos.',
  })
  @ApiOkResponse({ description: 'Catálogo de metadatos externos.' })
  @ApiBadRequestResponse({ description: 'Motor de base de datos no soportado.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiNotFoundResponse({ description: 'Conexión fuera del workspace o inexistente.' })
  @ApiBadGatewayResponse({ description: 'Falló la conexión o la consulta del catálogo externo.' })
  @ApiGatewayTimeoutResponse({ description: 'La exploración superó el límite de 10 segundos.' })
  explore(
    @Req() request: AuthenticatedRequest,
    @Param('connectionId', new ParseUUIDPipe({ version: '4' })) connectionId: string,
  ) {
    return this.dataEngineService.exploreConnection(request.user, connectionId);
  }
}
