import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { DataEngineService } from './data-engine.service.js';
import { CrossJoinDto, ExportCrossJoinDto } from './dto/cross-join.dto.js';
import { ConnectionHealthResponseDto } from './dto/connection-health.dto.js';

@ApiTags('Engine - Cross-Join & Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller(['engine', 'data-engine'])
export class DataEngineController {
  constructor(private readonly dataEngineService: DataEngineService) {}

  @Get('connections/health')
  @Roles('ADMIN', 'OPERADOR')
  @ApiOperation({
    summary: 'Comprobar el estado actual de las conexiones del workspace',
    description:
      'Valida conectividad y acceso al catálogo con un límite de 10 segundos. No devuelve credenciales ni datos del catálogo.',
  })
  @ApiOkResponse({ type: ConnectionHealthResponseDto })
  @ApiGatewayTimeoutResponse({ description: 'La consulta de conexiones superó el límite de 10 segundos.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR para consultar la salud de conexiones.' })
  getConnectionsHealth(@Req() request: AuthenticatedRequest) {
    return this.dataEngineService.getConnectionsHealth(request.user);
  }

  @Get('connections/:connectionId/schema')
  @Roles('ADMIN', 'OPERADOR')
  @ApiOperation({
    summary: 'Explorar tablas, vistas o colecciones de una conexión propia',
    description:
      'Devuelve solo metadatos del catálogo externo. No incluye credenciales ni filas/documentos.',
  })
  @ApiOkResponse({ description: 'Catálogo de metadatos externos.' })
  @ApiBadRequestResponse({
    description: 'Motor de base de datos no soportado.',
  })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR para explorar conexiones.' })
  @ApiNotFoundResponse({
    description: 'Conexión fuera del workspace o inexistente.',
  })
  @ApiBadGatewayResponse({
    description: 'Falló la conexión o la consulta del catálogo externo.',
  })
  @ApiGatewayTimeoutResponse({
    description: 'La exploración superó el límite de 10 segundos.',
  })
  explore(
    @Req() request: AuthenticatedRequest,
    @Param('connectionId', new ParseUUIDPipe({ version: '4' }))
    connectionId: string,
  ) {
    return this.dataEngineService.exploreConnection(request.user, connectionId);
  }

  @Post('join')
  @Roles('ADMIN', 'OPERADOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ejecutar Cross-Join en memoria entre fuentes SQL y NoSQL',
    description:
      'Cruza tablas relacionales y colecciones NoSQL por llaves foráneas. Disponible para ADMIN y OPERADOR.',
  })
  @ApiOkResponse({
    description: 'Resultado combinado del Inner Join con paginación nativa.',
  })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR para ejecutar Cross-Joins.' })
  @ApiNotFoundResponse({
    description: 'Alguna de las conexiones no existe en el workspace.',
  })
  @ApiBadGatewayResponse({
    description: 'Falló la extracción de una fuente externa.',
  })
  @ApiGatewayTimeoutResponse({
    description: 'La consulta a una fuente externa agotó el tiempo.',
  })
  @ApiPayloadTooLargeResponse({
    description: 'El origen o el resultado supera los límites configurados.',
  })
  async crossJoin(
    @Req() request: AuthenticatedRequest,
    @Body() payload: CrossJoinDto,
  ) {
    return this.dataEngineService.executeCrossJoin(payload, request.user);
  }

  @Throttle({ export: { limit: 20, ttl: 60000 } })
  @Post('export')
  @Roles('ADMIN', 'OPERADOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exportar resultado del Cross-Join (Excel, PDF o JSON)',
    description:
      'Genera y descarga el archivo con los datos combinados. Disponible para ADMIN y OPERADOR.',
  })
  @ApiOkResponse({
    description:
      'Archivo binario descargable con sus respectivos encabezados HTTP.',
  })
  @ApiBadRequestResponse({ description: 'Formato o parámetros no soportados.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR para exportar resultados.' })
  @ApiBadGatewayResponse({
    description: 'Falló la extracción de una fuente externa.',
  })
  @ApiGatewayTimeoutResponse({
    description: 'La consulta a una fuente externa agotó el tiempo.',
  })
  @ApiPayloadTooLargeResponse({
    description: 'El origen o el resultado supera los límites configurados.',
  })
  async exportJoin(
    @Req() request: AuthenticatedRequest,
    @Body() payload: ExportCrossJoinDto,
    @Res() res: Response,
  ) {
    const { buffer, contentType, filename } =
      await this.dataEngineService.executeCrossJoinForExport(
        payload,
        request.user,
      );

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }
}
