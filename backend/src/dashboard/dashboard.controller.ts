import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { DashboardSummaryDto } from './dto/dashboard-summary.dto.js';
import { DashboardService } from './dashboard.service.js';

@ApiTags('Dashboard')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @Header('Cache-Control', 'private, max-age=60')
  @ApiOperation({
    summary: 'Resumen del workspace para la Vista general (issue #40)',
    description:
      'Conexiones activas/caídas y latencia del último health check, Cross-Joins y exportaciones del mes con su variación, ' +
      'datos procesados frente al límite del plan, consumo de API de 7 días, consultas guardadas recientes, reportes próximos, ' +
      'actividad reciente de la bitácora y estado del entorno. Cualquier rol autenticado; las secciones que el rol no puede ' +
      'ver llegan como null. Se cachea 60 s por workspace y rol.',
  })
  @ApiOkResponse({ type: DashboardSummaryDto })
  getSummary(@Req() request: AuthenticatedRequest) {
    return this.dashboard.getSummary(request.user);
  }
}
