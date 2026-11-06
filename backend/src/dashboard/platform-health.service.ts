import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PlatformServiceDto } from './dto/dashboard-summary.dto.js';

/** Tiempo máximo de cada comprobación: el resumen del dashboard debe responder en menos de 300 ms. */
const CHECK_TIMEOUT_MS = 250;
/** Por encima de esto un servicio responde, pero lento. */
const DEGRADED_LATENCY_MS = 150;

class CheckTimeoutError extends Error {}

async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeoutError()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Estado de los servicios de la plataforma para "Estado del entorno" (issue #40). Nunca lanza. */
@Injectable()
export class PlatformHealthService implements OnModuleDestroy {
  private redis?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.redis?.disconnect();
  }

  async check(): Promise<PlatformServiceDto[]> {
    return Promise.all([this.checkDatabase(), this.checkRedis(), Promise.resolve(this.mailStatus()), Promise.resolve(this.storageStatus())]);
  }

  private async checkDatabase(): Promise<PlatformServiceDto> {
    const startedAt = performance.now();
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
      const latenciaMs = Math.round(performance.now() - startedAt);
      return {
        servicio: 'Base de datos',
        estado: latenciaMs > DEGRADED_LATENCY_MS ? 'DEGRADADO' : 'OPERATIVO',
        detalle: latenciaMs > DEGRADED_LATENCY_MS ? 'PostgreSQL responde con lentitud' : 'PostgreSQL responde',
        latenciaMs,
      };
    } catch (error) {
      return {
        servicio: 'Base de datos',
        estado: error instanceof CheckTimeoutError ? 'DEGRADADO' : 'CAIDO',
        detalle: error instanceof CheckTimeoutError ? 'PostgreSQL no respondió a tiempo' : 'No se pudo consultar PostgreSQL',
        latenciaMs: null,
      };
    }
  }

  /** Redis solo existe si hay REDIS_URL (cola de joins asíncronos, issue #33). */
  private async checkRedis(): Promise<PlatformServiceDto> {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      return {
        servicio: 'Cola de trabajos',
        estado: 'NO_CONFIGURADO',
        detalle: 'Sin REDIS_URL: los joins asíncronos usan la cola en memoria',
        latenciaMs: null,
      };
    }
    this.redis ??= new Redis(url, {
      lazyConnect: true,
      connectTimeout: CHECK_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', () => undefined);
    const startedAt = performance.now();
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') await withTimeout(this.redis.connect(), CHECK_TIMEOUT_MS);
      await withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS);
      const latenciaMs = Math.round(performance.now() - startedAt);
      return {
        servicio: 'Cola de trabajos',
        estado: latenciaMs > DEGRADED_LATENCY_MS ? 'DEGRADADO' : 'OPERATIVO',
        detalle: 'Redis responde',
        latenciaMs,
      };
    } catch {
      return { servicio: 'Cola de trabajos', estado: 'CAIDO', detalle: 'Redis no responde', latenciaMs: null };
    }
  }

  /** No se abre una conexión SMTP en cada consulta: se informa del modo configurado. */
  private mailStatus(): PlatformServiceDto {
    const configured = Boolean(
      this.config.get<string>('SMTP_HOST') && this.config.get<string>('SMTP_USER') && this.config.get<string>('SMTP_PASS'),
    );
    return configured
      ? { servicio: 'Correo', estado: 'OPERATIVO', detalle: 'SMTP configurado', latenciaMs: null }
      : { servicio: 'Correo', estado: 'NO_CONFIGURADO', detalle: 'Envío simulado: falta SMTP_HOST, SMTP_USER o SMTP_PASS', latenciaMs: null };
  }

  private storageStatus(): PlatformServiceDto {
    const provider = this.config.get<string>('REPORT_STORAGE_PROVIDER') ?? 'local';
    return {
      servicio: 'Almacenamiento de reportes',
      estado: 'OPERATIVO',
      detalle: provider === 'gcs' ? 'Google Cloud Storage' : 'Almacenamiento local',
      latenciaMs: null,
    };
  }
}
