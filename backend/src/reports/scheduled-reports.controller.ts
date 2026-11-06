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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import {
  CreateScheduledReportDto,
  ScheduledReportResponseDto,
  ScheduledReportRunResponseDto,
  ScheduledReportsSummaryDto,
  UpdateScheduledReportDto,
} from './dto/scheduled-report.dto.js';
import { ScheduledReportsService } from './scheduled-reports.service.js';

const UUID_PIPE = new ParseUUIDPipe({ version: '4' });

@ApiTags('Reports - Scheduled')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports/schedules')
export class ScheduledReportsController {
  constructor(private readonly scheduledReports: ScheduledReportsService) {}

  @Post()
  @RequirePermission('MANAGE_REPORTS')
  @ApiOperation({ summary: 'Crear una programación de reporte' })
  @ApiCreatedResponse({ type: ScheduledReportResponseDto })
  @ApiConflictResponse({ description: 'La consulta está en uso o la configuración no se puede programar.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR.' })
  create(@Req() request: AuthenticatedRequest, @Body() input: CreateScheduledReportDto) {
    return this.scheduledReports.create(request.user, input, this.auditContext(request));
  }

  @Get()
  @RequirePermission('MANAGE_REPORTS')
  @ApiOperation({ summary: 'Listar programaciones del workspace' })
  @ApiOkResponse({ type: ScheduledReportResponseDto, isArray: true })
  findAll(@Req() request: AuthenticatedRequest) {
    return this.scheduledReports.findAll(request.user);
  }

  @Get('summary')
  @RequirePermission('MANAGE_REPORTS')
  @ApiOperation({ summary: 'Resumen de programaciones y ejecuciones de hoy' })
  @ApiOkResponse({ type: ScheduledReportsSummaryDto })
  summary(@Req() request: AuthenticatedRequest) {
    return this.scheduledReports.summary(request.user);
  }

  @Get(':id')
  @RequirePermission('MANAGE_REPORTS')
  @ApiOperation({ summary: 'Consultar una programación' })
  @ApiOkResponse({ type: ScheduledReportResponseDto })
  @ApiNotFoundResponse({ description: 'Programación no encontrada en el workspace.' })
  findOne(@Req() request: AuthenticatedRequest, @Param('id', UUID_PIPE) id: string) {
    return this.scheduledReports.findOne(request.user, id);
  }

  @Patch(':id')
  @RequirePermission('MANAGE_REPORTS')
  @ApiOperation({ summary: 'Editar una programación' })
  @ApiOkResponse({ type: ScheduledReportResponseDto })
  @ApiNotFoundResponse({ description: 'Programación o consulta guardada no encontrada.' })
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', UUID_PIPE) id: string,
    @Body() input: UpdateScheduledReportDto,
  ) {
    return this.scheduledReports.update(request.user, id, input, this.auditContext(request));
  }

  @Delete(':id')
  @RequirePermission('MANAGE_REPORTS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar una programación y su historial' })
  @ApiOkResponse({ description: 'Programación eliminada.' })
  @ApiNotFoundResponse({ description: 'Programación no encontrada.' })
  remove(@Req() request: AuthenticatedRequest, @Param('id', UUID_PIPE) id: string) {
    return this.scheduledReports.remove(request.user, id, this.auditContext(request));
  }

  @Post(':id/pause')
  @RequirePermission('MANAGE_REPORTS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pausar una programación' })
  @ApiOkResponse({ type: ScheduledReportResponseDto })
  pause(@Req() request: AuthenticatedRequest, @Param('id', UUID_PIPE) id: string) {
    return this.scheduledReports.pause(request.user, id, this.auditContext(request));
  }

  @Post(':id/resume')
  @RequirePermission('MANAGE_REPORTS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reanudar una programación' })
  @ApiOkResponse({ type: ScheduledReportResponseDto })
  resume(@Req() request: AuthenticatedRequest, @Param('id', UUID_PIPE) id: string) {
    return this.scheduledReports.resume(request.user, id, this.auditContext(request));
  }

  @Post(':id/run')
  @RequirePermission('MANAGE_REPORTS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ejecutar ahora sin cambiar el horario ni el estado' })
  @ApiOkResponse({ type: ScheduledReportRunResponseDto })
  runNow(@Req() request: AuthenticatedRequest, @Param('id', UUID_PIPE) id: string) {
    return this.scheduledReports.runNow(request.user, id, this.auditContext(request));
  }

  @Get(':id/runs')
  @RequirePermission('MANAGE_REPORTS')
  @ApiOperation({ summary: 'Consultar ejecuciones y enlaces aún vigentes' })
  @ApiOkResponse({ type: ScheduledReportRunResponseDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Programación no encontrada.' })
  listRuns(@Req() request: AuthenticatedRequest, @Param('id', UUID_PIPE) id: string) {
    return this.scheduledReports.listRuns(request.user, id);
  }

  private auditContext(request: AuthenticatedRequest) {
    return { ipAddress: request.ip, userAgent: request.get('user-agent') };
  }
}
