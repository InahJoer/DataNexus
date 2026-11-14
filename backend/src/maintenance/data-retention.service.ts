import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';

/** Sesiones revocadas o vencidas se conservan unos días para poder revisar accesos recientes. */
export const SESSION_RETENTION_DAYS = 7;
/** Filas por lote: borra poco a poco para no disparar el WAL en volúmenes pequeños. */
export const RETENTION_BATCH_SIZE = 5_000;
/** Tope de lotes por ejecución (≈1 millón de filas); lo que quede se borra en la siguiente. */
export const RETENTION_MAX_BATCHES = 200;
const STARTUP_DELAY_MS = 60_000;
const DAY_MS = 86_400_000;

export interface RetentionResult {
  sesiones: number;
  tokensRecuperacion: number;
}

/**
 * Limpieza diaria de datos de autenticación que ya no sirven y solo ocupan disco:
 * - sesiones vencidas o revocadas hace más de SESSION_RETENTION_DAYS (sus refresh tokens se borran en cascada);
 * - tokens de recuperación de contraseña vencidos, o usados hace más de SESSION_RETENTION_DAYS.
 *
 * Corre a las 03:30 UTC y una vez poco después de arrancar (en Railway la API se reinicia con cada despliegue).
 * Es idempotente: con varias réplicas, la segunda simplemente no encuentra nada que borrar.
 *
 * La bitácora de auditoría NO se toca: es inmutable (RF-26, trigger en PostgreSQL) y se conserva al menos 5 años
 * (SLA-OLA.md). Para liberar espacio de la bitácora se exporta y archiva fuera, según DRP.md.
 */
@Injectable()
export class DataRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DataRetentionService.name);
  private running?: Promise<RetentionResult>;
  private startupTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.startupTimer = setTimeout(() => void this.runScheduled(), STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
  }

  // ScheduleModule.forRoot() ya se registra en ReportsModule; @Cron funciona en cualquier módulo.
  @Cron('0 30 3 * * *', { name: 'data-retention', timeZone: 'UTC' })
  async runScheduled(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      // Un fallo (p. ej. la base caída) no debe tumbar la API: se reintenta en la siguiente ejecución.
      this.logger.error(`La limpieza de retención falló: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Ejecuta la limpieza. Si ya hay una en curso, devuelve esa misma. */
  run(now: Date = new Date()): Promise<RetentionResult> {
    this.running ??= this.purge(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async purge(now: Date): Promise<RetentionResult> {
    const sessionCutoff = new Date(now.getTime() - SESSION_RETENTION_DAYS * DAY_MS);

    const sesiones = await this.inBatches(
      (take) =>
        this.prisma.userSession.findMany({
          where: { OR: [{ expiresAt: { lt: sessionCutoff } }, { revokedAt: { lt: sessionCutoff } }] },
          select: { id: true },
          take,
        }),
      (ids) => this.prisma.userSession.deleteMany({ where: { id: { in: ids } } }),
    );
    const tokensRecuperacion = await this.inBatches(
      (take) =>
        this.prisma.passwordResetToken.findMany({
          where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: sessionCutoff } }] },
          select: { id: true },
          take,
        }),
      (ids) => this.prisma.passwordResetToken.deleteMany({ where: { id: { in: ids } } }),
    );

    const result = { sesiones, tokensRecuperacion };
    if (sesiones + tokensRecuperacion > 0) {
      this.logger.log(`Retención: ${sesiones} sesiones y ${tokensRecuperacion} tokens de recuperación eliminados`);
    }
    return result;
  }

  private async inBatches(
    find: (take: number) => Promise<{ id: string }[]>,
    remove: (ids: string[]) => Promise<{ count: number }>,
  ): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
      const rows = await find(RETENTION_BATCH_SIZE);
      if (rows.length === 0) break;
      total += (await remove(rows.map((row) => row.id))).count;
      if (rows.length < RETENTION_BATCH_SIZE) break;
    }
    return total;
  }
}
