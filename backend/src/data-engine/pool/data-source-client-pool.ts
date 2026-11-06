import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 50;
const SWEEP_INTERVAL_MS = 30_000;

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export interface PoolKey {
  /** Id de la conexión guardada; permite invalidar todos sus clientes. */
  connectionId: string;
  /** Cadena del driver; su huella separa clientes si cambian las credenciales. */
  connectionString: string;
  /** Distingue clientes del mismo motor con opciones distintas (p. ej. base de datos). */
  variant?: string;
}

interface PoolEntry {
  connectionId: string;
  client: Promise<unknown>;
  dispose: (client: any) => Promise<void>;
  lastUsedAt: number;
  inUse: number;
}

export interface PoolStats {
  size: number;
  connections: string[];
}

/**
 * Caché de clientes de bases externas (pools de pg/mysql2/mssql, instancias de Firestore) por conexión.
 *
 * - Reutiliza el cliente mientras la conexión y sus credenciales no cambien (la clave incluye una huella
 *   SHA-256 de la cadena, nunca la cadena en claro).
 * - Cierra los clientes sin uso tras DATA_SOURCE_POOL_IDLE_MS (5 min por defecto) y, si se supera
 *   DATA_SOURCE_POOL_MAX_ENTRIES (50), el menos usado recientemente.
 * - `invalidate(connectionId)` se llama al editar o eliminar la conexión.
 * - Al apagar la aplicación (OnModuleDestroy) cierra todos los clientes.
 */
@Injectable()
export class DataSourceClientPool implements OnModuleDestroy {
  private readonly logger = new Logger(DataSourceClientPool.name);
  private readonly entries = new Map<string, PoolEntry>();
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    idleTtlMs = positiveIntegerFromEnv('DATA_SOURCE_POOL_IDLE_MS', DEFAULT_IDLE_TTL_MS),
    maxEntries = positiveIntegerFromEnv('DATA_SOURCE_POOL_MAX_ENTRIES', DEFAULT_MAX_ENTRIES),
    private readonly now: () => number = Date.now,
  ) {
    this.idleTtlMs = idleTtlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Ejecuta `use` con el cliente de la conexión, creándolo con `create` si no existe. Si la creación falla,
   * no queda nada en caché y el siguiente intento vuelve a probar.
   */
  async withClient<T, R>(
    key: PoolKey,
    create: () => Promise<T>,
    dispose: (client: T) => Promise<void>,
    use: (client: T) => Promise<R>,
  ): Promise<R> {
    const id = this.keyOf(key);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        connectionId: key.connectionId,
        client: create(),
        dispose: dispose as (client: unknown) => Promise<void>,
        lastUsedAt: this.now(),
        inUse: 0,
      };
      this.entries.set(id, entry);
      entry.client.catch(() => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
      });
      this.ensureSweeper();
      void this.evictOverflow(id);
    }

    entry.inUse += 1;
    entry.lastUsedAt = this.now();
    try {
      const client = (await entry.client) as T;
      return await use(client);
    } finally {
      entry.inUse -= 1;
      entry.lastUsedAt = this.now();
    }
  }

  /** Cierra y olvida todos los clientes de una conexión (al editarla, eliminarla o tras un timeout). */
  async invalidate(connectionId: string): Promise<void> {
    const removed = [...this.entries].filter(([, entry]) => entry.connectionId === connectionId);
    for (const [id] of removed) this.entries.delete(id);
    await Promise.all(removed.map(([, entry]) => this.disposeEntry(entry)));
  }

  /** Cierra los clientes sin uso desde hace más de idleTtlMs. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.idleTtlMs;
    const idle = [...this.entries].filter(([, entry]) => entry.inUse === 0 && entry.lastUsedAt <= cutoff);
    for (const [id] of idle) this.entries.delete(id);
    await Promise.all(idle.map(([, entry]) => this.disposeEntry(entry)));
    if (this.entries.size === 0) this.stopSweeper();
    return idle.length;
  }

  stats(): PoolStats {
    return {
      size: this.entries.size,
      connections: [...new Set([...this.entries.values()].map((entry) => entry.connectionId))],
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.stopSweeper();
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((entry) => this.disposeEntry(entry)));
  }

  private keyOf(key: PoolKey): string {
    const fingerprint = createHash('sha256').update(key.connectionString, 'utf8').digest('hex').slice(0, 32);
    return `${key.connectionId}:${key.variant ?? ''}:${fingerprint}`;
  }

  /** Si se supera el máximo, cierra los clientes inactivos menos usados recientemente. */
  private async evictOverflow(keep: string): Promise<void> {
    if (this.entries.size <= this.maxEntries) return;
    const candidates = [...this.entries]
      .filter(([id, entry]) => id !== keep && entry.inUse === 0)
      .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
      .slice(0, this.entries.size - this.maxEntries);
    for (const [id] of candidates) this.entries.delete(id);
    await Promise.all(candidates.map(([, entry]) => this.disposeEntry(entry)));
  }

  private async disposeEntry(entry: PoolEntry): Promise<void> {
    try {
      const client = await entry.client;
      await entry.dispose(client);
    } catch {
      // Un cliente que no llegó a crearse o que ya estaba cerrado no requiere más limpieza.
      this.logger.debug(`Cliente de la conexión ${entry.connectionId} ya cerrado o no creado`);
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), Math.min(SWEEP_INTERVAL_MS, this.idleTtlMs));
    // No mantiene vivo el proceso (tests, scripts o apagado).
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}
