import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { RequirePermission } from '../../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../../auth/interfaces/authenticated-user.interface.js';
import { CrossJoinDto } from '../dto/cross-join.dto.js';
import { JOB_STATES } from './join-job.store.js';
import { JoinJobsService } from './join-jobs.service.js';

export class JobResultQueryDto {
  @ApiPropertyOptional({ default: 0, minimum: 0, description: 'Desplazamiento dentro del resultado' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 1000, description: 'Filas del resultado por página' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit: number = 50;
}

class JobResultPageDto {
  @ApiProperty({ example: 120000 }) total: number;
  @ApiProperty({ example: 0 }) offset: number;
  @ApiProperty({ example: 50 }) limit: number;
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) data: Record<string, unknown>[];
}

export class JoinJobStatusDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: JOB_STATES, example: 'EN_PROCESO' }) estado: string;
  @ApiProperty({ minimum: 0, maximum: 100, example: 45 }) progreso: number;
  @ApiProperty({ example: 'dbo.clientes x pedidos' }) descripcion: string;
  @ApiProperty({ example: 'ana@empresa.com' }) creadoPor: string;
  @ApiProperty({ format: 'date-time' }) creadoEn: string;
  @ApiPropertyOptional({ format: 'date-time' }) iniciadoEn?: string;
  @ApiPropertyOptional({ format: 'date-time' }) terminadoEn?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Cuándo se borran el estado y el resultado' }) expiraEn?: string;
  @ApiPropertyOptional({ example: 120000 }) totalFilas?: number;
  @ApiPropertyOptional() truncado?: boolean;
  @ApiPropertyOptional({ example: 'El join supera el máximo de 100000 filas configurado' }) error?: string;
  @ApiPropertyOptional({ type: JobResultPageDto, description: 'Solo cuando el estado es COMPLETADO' })
  resultado?: JobResultPageDto;
}

/**
 * Joins asíncronos (RNF-04): para cruces pesados que no conviene esperar en una sola petición.
 * Mismo payload y mismos permisos que POST /engine/join.
 */
@ApiTags('Engine - Joins asíncronos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller(['engine/jobs', 'data-engine/jobs'])
export class JoinJobsController {
  constructor(private readonly jobs: JoinJobsService) {}

  @Post()
  @RequirePermission('RUN_JOINS')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Encolar un cross-join pesado',
    description:
      'Valida el payload, lo encola y responde enseguida con el id del job. El join se ejecuta en segundo plano ' +
      'sin bloquear el servidor. Consulte su estado y resultado con GET /engine/jobs/:id.',
  })
  @ApiAcceptedResponse({ type: JoinJobStatusDto })
  @ApiBadRequestResponse({ description: 'Payload inválido (mismas reglas que POST /engine/join).' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR.' })
  @ApiTooManyRequestsResponse({ description: 'El workspace alcanzó el máximo de joins en cola o en proceso.' })
  enqueue(@Req() request: AuthenticatedRequest, @Body() payload: CrossJoinDto) {
    return this.jobs.enqueue(payload, request);
  }

  @Get()
  @RequirePermission('RUN_JOINS')
  @ApiOperation({ summary: 'Listar los joins asíncronos del workspace (los propios; ADMIN ve todos)' })
  @ApiOkResponse({ type: [JoinJobStatusDto] })
  list(@Req() request: AuthenticatedRequest) {
    return this.jobs.list(request.user);
  }

  @Get(':jobId')
  @RequirePermission('RUN_JOINS')
  @ApiOperation({
    summary: 'Estado, progreso y resultado paginado de un join asíncrono',
    description: 'Cuando el estado es COMPLETADO incluye `resultado` con `offset` y `limit`. El resultado expira tras JOBS_RESULT_TTL_SECONDS.',
  })
  @ApiOkResponse({ type: JoinJobStatusDto })
  @ApiNotFoundResponse({ description: 'Job inexistente, expirado o de otro usuario/workspace.' })
  get(
    @Req() request: AuthenticatedRequest,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
    @Query() query: JobResultQueryDto,
  ) {
    return this.jobs.getStatus(request.user, jobId, query.offset, query.limit);
  }

  @Delete(':jobId')
  @RequirePermission('RUN_JOINS')
  @ApiOperation({ summary: 'Cancelar un join asíncrono en cola o en proceso' })
  @ApiOkResponse({ type: JoinJobStatusDto })
  @ApiNotFoundResponse({ description: 'Job inexistente, expirado o de otro usuario/workspace.' })
  @ApiConflictResponse({ description: 'El job ya terminó.' })
  cancel(@Req() request: AuthenticatedRequest, @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string) {
    return this.jobs.cancel(request.user, jobId);
  }
}
