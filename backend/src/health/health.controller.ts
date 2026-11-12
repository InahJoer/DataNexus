import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthIndicators } from './health.indicators.js';

/**
 * Sondas de salud para Docker, Railway y el monitoreo de disponibilidad (RNF-09, issue #51).
 * Son públicas y no devuelven datos de negocio ni de configuración sensible.
 */
@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicators,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness: el proceso responde',
    description: 'No consulta dependencias. Úsala como health check del contenedor para no reiniciarlo por una caída de la base de datos.',
  })
  @ApiResponse({ status: 200, description: 'La API está viva' })
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness: PostgreSQL, Redis y SMTP',
    description:
      'Responde 503 si PostgreSQL o Redis (cuando REDIS_URL está configurado) no responden. ' +
      'Un fallo de SMTP deja el estado en `degraded` con HTTP 200: la API sigue sirviendo, pero los correos fallarán.',
  })
  ready() {
    return this.health.check([
      () => this.indicators.database(),
      () => this.indicators.redisQueue(),
      () => this.indicators.smtp(),
    ]);
  }
}
