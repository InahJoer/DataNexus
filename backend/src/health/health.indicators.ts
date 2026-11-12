import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorService, PrismaHealthIndicator } from '@nestjs/terminus';
import { Redis } from 'ioredis';
import { MailService } from '../mailer/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Tiempo máximo de cada comprobación de dependencias. */
export const HEALTH_CHECK_TIMEOUT_MS = 2000;
/** Abrir una conexión SMTP en cada sondeo es caro: el resultado se reutiliza durante un minuto. */
const SMTP_CHECK_CACHE_MS = 60_000;

/**
 * Indicadores de salud de las dependencias de la API (issue #51).
 * - PostgreSQL y Redis son críticos: si fallan, /health/ready responde 503.
 * - SMTP solo afecta a los correos: un fallo marca el servicio como `degraded` sin sacar la API de servicio.
 */
@Injectable()
export class HealthIndicators implements OnModuleDestroy {
  private redis?: Redis;

  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  database() {
    return this.prismaIndicator.pingCheck('database', this.prisma).withTimeout(HEALTH_CHECK_TIMEOUT_MS);
  }

  async redisQueue() {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) return this.health.check('redis').up({ mode: 'memory', message: 'Sin REDIS_URL: cola en memoria' });

    this.redis ??= this.createRedis(url);
    const redis = this.redis;
    return this.health
      .check('redis')
      .attempt(async () => {
        if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
        await redis.ping();
      })
      .withTimeout(HEALTH_CHECK_TIMEOUT_MS);
  }

  async smtp() {
    const session = this.health.check('smtp');
    if (!this.mail.isConfigured()) return session.up({ mode: 'simulated', message: 'Sin SMTP configurado: envío simulado' });
    const result = await session
      .attempt(() => this.mail.verify())
      .withTimeout(HEALTH_CHECK_TIMEOUT_MS)
      .cacheFor(SMTP_CHECK_CACHE_MS);
    return result.smtp.status === 'up'
      ? session.up({ mode: 'smtp' })
      : session.degraded({ mode: 'smtp', message: 'El servidor SMTP no responde o rechaza las credenciales' });
  }

  private createRedis(url: string): Redis {
    const redis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on('error', () => undefined);
    return redis;
  }
}
