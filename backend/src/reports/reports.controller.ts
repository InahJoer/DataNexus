import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  Get,
  Param,
  Query,
  StreamableFile,
  Header,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { ReportsService } from './reports.service.js';
import { TriggerReportDto } from './dto/trigger-report.dto.js';

@ApiTags('Reports - Automation')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post('trigger')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermission('MANAGE_REPORTS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disparar ejecución y envío de reporte por correo',
    description:
      'Ejecuta el cruce de datos, almacena el archivo fuera de memoria y envía a los destinatarios un enlace seguro de descarga con 24 horas de vigencia. Requiere rol ADMIN u OPERADOR.',
  })
  @ApiOkResponse({ description: 'Reporte generado y enviado con éxito.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN u OPERADOR para automatizar reportes.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  async trigger(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TriggerReportDto,
  ) {
    return this.reportsService.triggerReport(request.user, dto);
  }

  @Get('download/:id')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Descargar un reporte local con enlace firmado',
    description:
      'Valida el enlace firmado de 24 horas y transmite el archivo desde almacenamiento local. Los reportes GCS usan su URL firmada directamente.',
  })
  @ApiParam({ name: 'id', description: 'UUID aleatorio del reporte', format: 'uuid' })
  @ApiQuery({ name: 'filename', required: true, description: 'Nombre del archivo incluido en el enlace firmado' })
  @ApiQuery({ name: 'expires', required: true, description: 'Vencimiento del enlace en segundos Unix' })
  @ApiQuery({ name: 'signature', required: true, description: 'Firma HMAC del enlace' })
  @ApiOkResponse({
    description: 'Archivo de reporte transmitido.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiUnauthorizedResponse({ description: 'El enlace es inválido o expiró.' })
  @ApiNotFoundResponse({ description: 'El reporte no existe en almacenamiento local.' })
  async downloadLocalReport(
    @Param('id') id: string,
    @Query('filename') filename: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
  ): Promise<StreamableFile> {
    const download = await this.reportsService.openLocalDownload(id, filename, expires, signature);
    return new StreamableFile(download.stream, {
      type: download.contentType,
      disposition: `attachment; filename="${download.filename}"`,
    });
  }
}
