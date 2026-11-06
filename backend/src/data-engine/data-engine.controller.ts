import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
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
  ApiQuery,
  ApiPayloadTooLargeResponse,
  ApiConflictResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { AuditService } from '../audit/audit.service.js';
import { DataEngineService } from './data-engine.service.js';
import { buildBrowseAuditEvent, buildDataAccessAuditEvent } from './data-access-audit.js';
import { BrowseDataQueryDto, BrowseDataResponseDto } from './dto/browse-data.dto.js';
import { CrossJoinDto, ExportCrossJoinDto } from './dto/cross-join.dto.js';
import { ConnectionHealthResponseDto } from './dto/connection-health.dto.js';
import { ConnectionFieldsResponseDto, ConnectionSchemaResponseDto } from './dto/connection-schema.dto.js';
import { PaginatedCrossJoinResultDto } from './dto/cross-join-result.dto.js';
import { ExploreFieldsQueryDto } from './dto/explore-fields.dto.js';
import { UpdateRecordDto } from './dto/update-record.dto.js';

@ApiTags('Engine - Cross-Join & Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller(['engine', 'data-engine'])
export class DataEngineController {
  constructor(
    private readonly dataEngineService: DataEngineService,
    private readonly auditService: AuditService,
  ) {}

  @Get('connections/health')
  @RequirePermission('VIEW_CONNECTIONS')
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
  @RequirePermission('EXPLORE_DATA')
  @ApiOperation({
    summary: 'Explorar tablas, vistas o colecciones de una conexión propia',
    description:
      'Devuelve solo metadatos del catálogo externo. No incluye credenciales ni filas/documentos.',
  })
  @ApiOkResponse({ type: ConnectionSchemaResponseDto, description: 'Catálogo de metadatos externos.' })
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

  @Get('connections/:connectionId/schema/fields')
  @RequirePermission('EXPLORE_DATA')
  @ApiOperation({ summary: 'Listar los campos de una tabla o colección para configurar un cruce' })
  @ApiQuery({ name: 'objectName', required: true, maxLength: 150 })
  @ApiQuery({ name: 'schema', required: false, maxLength: 128 })
  @ApiOkResponse({ type: ConnectionFieldsResponseDto })
  @ApiBadRequestResponse({ description: 'La exploración de campos no está disponible para este motor.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR para explorar campos.' })
  @ApiNotFoundResponse({ description: 'Conexión, tabla o colección inexistente.' })
  @ApiBadGatewayResponse({ description: 'Falló la consulta de metadatos en la fuente.' })
  @ApiGatewayTimeoutResponse({ description: 'La exploración de campos superó el límite de 10 segundos.' })
  exploreFields(
    @Req() request: AuthenticatedRequest,
    @Param('connectionId', new ParseUUIDPipe({ version: '4' })) connectionId: string,
    @Query() query: ExploreFieldsQueryDto,
  ) {
    return this.dataEngineService.exploreConnectionFields(
      request.user,
      connectionId,
      query.objectName,
      query.schema,
    );
  }

  @Get('connections/:connectionId/data')
  @RequirePermission('EXPLORE_DATA')
  @ApiOperation({
    summary: 'Explorar los datos de una tabla o colección con paginación por cursor',
    description:
      'Devuelve una página y `nextCursor` para pedir la siguiente. Usa cursores nativos de cada motor (keyset sobre la ' +
      'llave primaria en SQL, `_id` en MongoDB, `startAfter` en Firestore): cualquier página cuesta lo mismo y la ' +
      'memoria es constante aunque la tabla tenga millones de filas (RNF-06). Las tablas SQL necesitan llave primaria.',
  })
  @ApiOkResponse({ type: BrowseDataResponseDto })
  @ApiBadRequestResponse({ description: 'Parámetros, filtros o cursor no válidos; motor sin paginación o tabla sin llave primaria.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR para explorar datos.' })
  @ApiNotFoundResponse({ description: 'Conexión fuera del workspace o inexistente.' })
  @ApiBadGatewayResponse({ description: 'Falló la consulta en la fuente externa.' })
  @ApiGatewayTimeoutResponse({ description: 'La lectura de la página superó el límite de 10 segundos.' })
  @ApiPayloadTooLargeResponse({ description: 'La página supera el máximo de bytes configurado.' })
  async browseData(
    @Req() request: AuthenticatedRequest,
    @Param('connectionId', new ParseUUIDPipe({ version: '4' })) connectionId: string,
    @Query() query: BrowseDataQueryDto,
  ) {
    try {
      const result = await this.dataEngineService.browseData(request.user, connectionId, query);
      // Se registra el inicio de cada recorrido (primera página), no cada página siguiente.
      if (!query.cursor) await this.auditService.record(buildBrowseAuditEvent(request, connectionId, query, { filas: result.filas }));
      return result;
    } catch (error) {
      try {
        await this.auditService.record(buildBrowseAuditEvent(request, connectionId, query, { error }));
      } catch {
        // El error de negocio original es el que debe llegar al cliente.
      }
      throw error;
    }
  }

  @Patch('records')
  @RequirePermission('MODIFY_RECORDS')
  @ApiOperation({
    summary: 'Actualizar una celda de una fila en su fuente de origen',
    description:
      'Disponible para ADMIN y OPERADOR en PostgreSQL, MySQL, SQL Server y Firestore. Requiere el valor observado para rechazar cambios concurrentes; los conflictos devuelven 409.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        actualizada: { type: 'boolean', example: true },
        entidad: { type: 'string', example: 'clientes' },
        campo: { type: 'string', example: 'nombre' },
        valorAnterior: { nullable: true, oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
        valorNuevo: { nullable: true, oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Payload, entidad, campo o llave primaria no válidos.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN y OPERADOR pueden editar registros.' })
  @ApiNotFoundResponse({ description: 'Conexión fuera del workspace, tabla o registro inexistente.' })
  @ApiConflictResponse({ description: 'El valor de la celda cambió desde la última lectura.' })
  @ApiBadGatewayResponse({ description: 'Falló la actualización en la fuente externa.' })
  @ApiGatewayTimeoutResponse({ description: 'La actualización superó el tiempo máximo de la fuente.' })
  @ApiServiceUnavailableResponse({ description: 'La celda se actualizó, pero no se pudo guardar el evento de auditoría.' })
  async updateRecord(@Req() request: AuthenticatedRequest, @Body() input: UpdateRecordDto) {
    const result = await this.dataEngineService.updateRecord(request.user, input);
    try {
      await this.auditService.record({
        eventType: 'MODIFY_RECORD',
        outcome: 'SUCCESS',
        actorUserId: request.user.id,
        actorEmail: request.user.email,
        workspaceId: request.user.workspaceId,
        targetType: 'RECORD',
        details: {
          conexionId: input.conexionId,
          entidad: input.entidad,
          ...(input.esquema ? { esquema: input.esquema } : {}),
          llavePrimaria: input.llavePrimaria,
          campo: input.campo,
          valorAnterior: result.valorAnterior,
          valorNuevo: result.valorNuevo,
        },
        ipAddress: request.ip,
        userAgent: request.get('user-agent') ?? undefined,
      });
    } catch {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'AUDIT_WRITE_FAILED_AFTER_MUTATION',
        message: 'La celda se actualizó, pero no se pudo guardar el evento de auditoría. Vuelve a leer el registro antes de reintentar.',
        mutationApplied: true,
      });
    }
    return result;
  }

  @Post('join')
  @RequirePermission('RUN_JOINS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ejecutar Cross-Join en memoria entre fuentes SQL y NoSQL',
    description:
      'Cruza tablas relacionales y colecciones NoSQL por llaves foráneas. Disponible para ADMIN y OPERADOR.',
  })
  @ApiOkResponse({ type: PaginatedCrossJoinResultDto, description: 'Resultado combinado del Inner Join con paginación nativa.' })
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
    try {
      const result = await this.dataEngineService.executeCrossJoin(payload, request.user);
      await this.auditService.record(
        buildDataAccessAuditEvent('EXECUTE_JOIN', request, payload, { totalFilas: result.total }),
      );
      return result;
    } catch (error) {
      await this.recordFailure('EXECUTE_JOIN', request, payload, error);
      throw error;
    }
  }

  @Throttle({ export: { limit: 20, ttl: 60000 } })
  @Post('export')
  @RequirePermission('EXPORT_DATA')
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
    let exportResult: Awaited<ReturnType<DataEngineService['executeCrossJoinForExport']>>;
    try {
      exportResult = await this.dataEngineService.executeCrossJoinForExport(payload, request.user);
    } catch (error) {
      await this.recordFailure('EXPORT', request, payload, error);
      throw error;
    }
    const { buffer, contentType, filename } = exportResult;
    await this.auditService.record(
      buildDataAccessAuditEvent('EXPORT', request, payload, { totalFilas: exportResult.totalRows }),
    );

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }

  /** Registra el intento fallido sin ocultar el error original si la bitácora también falla. */
  private async recordFailure(
    eventType: 'EXECUTE_JOIN' | 'EXPORT',
    request: AuthenticatedRequest,
    payload: CrossJoinDto | ExportCrossJoinDto,
    error: unknown,
  ): Promise<void> {
    try {
      await this.auditService.record(buildDataAccessAuditEvent(eventType, request, payload, { error }));
    } catch {
      // El error de negocio original es el que debe llegar al cliente.
    }
  }
}
