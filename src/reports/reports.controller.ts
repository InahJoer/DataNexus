import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { ReportsService } from './reports.service.js';
import { TriggerReportDto } from './dto/trigger-report.dto.js';

@ApiTags('Reports - Automation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disparar ejecución y envío de reporte por correo',
    description:
      'Ejecuta el cruce de datos en memoria, genera el archivo (Excel o PDF) y lo despacha como adjunto a los correos indicados. Requiere rol ADMIN.',
  })
  @ApiOkResponse({ description: 'Reporte generado y enviado con éxito.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN para automatizar reportes.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  async trigger(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TriggerReportDto,
  ) {
    return this.reportsService.triggerReport(request.user, dto);
  }
}
