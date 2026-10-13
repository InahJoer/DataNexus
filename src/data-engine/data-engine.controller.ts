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
import { CrossJoinDto, ExportCrossJoinDto } from './dto/cross-join.dto.js';

@ApiTags('Engine - Cross-Join & Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller(['engine', 'data-engine'])
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

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ejecutar Cross-Join en memoria entre fuentes SQL y NoSQL',
    description:
      'Cruza tablas relacionales y colecciones NoSQL por llaves foráneas. Aplica enmascaramiento automático de datos sensibles si el rol del usuario es LECTOR.',
  })
  @ApiOkResponse({ description: 'Resultado combinado del Inner Join con paginación nativa.' })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiNotFoundResponse({ description: 'Alguna de las conexiones no existe en el workspace.' })
  async crossJoin(
    @Req() request: AuthenticatedRequest,
    @Body() payload: CrossJoinDto,
  ) {
    return this.dataEngineService.executeCrossJoin(payload, request.user);
  }

  @Post('export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exportar resultado del Cross-Join (Excel, PDF o JSON)',
    description:
      'Genera y descarga el archivo con los datos combinados y enmascarados según el rol del usuario.',
  })
  @ApiOkResponse({ description: 'Archivo binario descargable con sus respectivos encabezados HTTP.' })
  @ApiBadRequestResponse({ description: 'Formato o parámetros no soportados.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  async exportJoin(
    @Req() request: AuthenticatedRequest,
    @Body() payload: ExportCrossJoinDto,
    @Res() res: Response,
  ) {
    const { buffer, contentType, filename } =
      await this.dataEngineService.executeCrossJoinForExport(payload, request.user);

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }
}
