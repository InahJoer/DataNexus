import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

const FLUSH_INTERVAL_MS = 15_000;

interface PendingUsage {
  workspaceId: string;
  /** Día UTC en formato YYYY-MM-DD. */
  day: string;
  apiRequests: number;
  bytesProcessed: number;
}

export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Medidor de uso por workspace (issue #40): solicitudes autenticadas a la API y bytes extraídos de las fuentes.
 * Acumula en memoria y vuelca a WorkspaceUsageDaily cada 15 s con incrementos atómicos (INSERT ... ON CONFLICT),
 * así ninguna solicitud espera a la base de datos y varias réplicas pueden sumar sobre el mismo día.
 */
@Injectable()
export class UsageMeterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageMeterService.name);
  private pending = new Map<string, PendingUsage>();
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  recordApiRequest(workspaceId: string, at: Date = new Date()): void {
    this.entry(workspaceId, at).apiRequests += 1;
  }

  recordBytesProcessed(workspaceId: string, bytes: number, at: Date = new Date()): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.entry(workspaceId, at).bytesProcessed += Math.round(bytes);
  }

  /** Uso aún no volcado de este proceso, para que el dashboard muestre el día en curso al instante. */
  pendingFor(workspaceId: string): PendingUsage[] {
    return [...this.pending.values()].filter((usage) => usage.workspaceId === workspaceId).map((usage) => ({ ...usage }));
  }

  /** Vuelca lo acumulado. Si la base falla, devuelve los contadores al buffer para el siguiente intento. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.pending.size === 0) return;

    const batch = [...this.pending.values()];
    this.pending = new Map();
    this.flushing = (async () => {
      for (const usage of batch) {
        try {
          await this.prisma.$executeRaw`
            INSERT INTO "WorkspaceUsageDaily" ("workspaceId", "dia", "solicitudesApi", "bytesProcesados")
            VALUES (${usage.workspaceId}, ${usage.day}::date, ${usage.apiRequests}, ${BigInt(usage.bytesProcessed)})
            ON CONFLICT ("workspaceId", "dia") DO UPDATE SET
              "solicitudesApi" = "WorkspaceUsageDaily"."solicitudesApi" + EXCLUDED."solicitudesApi",
              "bytesProcesados" = "WorkspaceUsageDaily"."bytesProcesados" + EXCLUDED."bytesProcesados"`;
        } catch (error) {
          // El workspace pudo eliminarse (FK): en ese caso se descarta, no se reintenta para siempre.
          if (isForeignKeyViolation(error)) continue;
          const entry = this.entry(usage.workspaceId, new Date(`${usage.day}T00:00:00Z`));
          entry.apiRequests += usage.apiRequests;
          entry.bytesProcessed += usage.bytesProcessed;
          this.logger.warn(`No se pudo volcar el uso del workspace ${usage.workspaceId}; se reintentará`);
        }
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }

  private entry(workspaceId: string, at: Date): PendingUsage {
    const day = utcDay(at);
    const key = `${workspaceId}|${day}`;
    let usage = this.pending.get(key);
    if (!usage) {
      usage = { workspaceId, day, apiRequests: 0, bytesProcessed: 0 };
      this.pending.set(key, usage);
    }
    return usage;
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  const record = error as { code?: string; meta?: { code?: string } } | null;
  return record?.meta?.code === '23503' || String((error as Error)?.message ?? '').includes('23503');
}
