import type { Redis } from 'ioredis';

export const JOB_STATES = ['EN_COLA', 'EN_PROCESO', 'COMPLETADO', 'FALLIDO', 'CANCELADO'] as const;
export type JobState = (typeof JOB_STATES)[number];
export const ACTIVE_STATES: readonly JobState[] = ['EN_COLA', 'EN_PROCESO'];

/** Estado de un join asíncrono. Nunca guarda filtros ni credenciales: el payload se guarda aparte y expira. */
export interface JoinJobRecord {
  id: string;
  workspaceId: string;
  userId: string;
  userEmail: string;
  userName: string;
  role: string;
  estado: JobState;
  /** 0 a 100. */
  progreso: number;
  /** Entidades unidas, p. ej. `dbo.clientes x pedidos`. */
  descripcion: string;
  creadoEn: string;
  iniciadoEn?: string;
  terminadoEn?: string;
  /** Cuándo se borran el resultado y el estado. */
  expiraEn?: string;
  totalFilas?: number;
  truncado?: boolean;
  error?: string;
  ip?: string;
  userAgent?: string;
}

/** Almacén de jobs: estado, payload, resultado paginable y señal de cancelación, con expiración automática. */
export interface JoinJobStore {
  create(record: JoinJobRecord, payload: unknown): Promise<void>;
  get(id: string): Promise<JoinJobRecord | null>;
  getPayload(id: string): Promise<unknown>;
  update(id: string, patch: Partial<JoinJobRecord>): Promise<JoinJobRecord | null>;
  listByWorkspace(workspaceId: string): Promise<JoinJobRecord[]>;
  saveResult(id: string, rows: Record<string, unknown>[]): Promise<void>;
  readResult(id: string, offset: number, limit: number): Promise<Record<string, unknown>[]>;
  /** Programa el borrado del job, su payload y su resultado. */
  expire(id: string, ttlSeconds: number): Promise<void>;
  requestCancel(id: string): Promise<void>;
  isCancelRequested(id: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Almacén en memoria (una sola instancia). Lo usa la cola local cuando no hay REDIS_URL: misma API y misma
 * expiración que Redis, pero se pierde al reiniciar el servidor.
 */
export class InMemoryJoinJobStore implements JoinJobStore {
  private readonly records = new Map<string, JoinJobRecord>();
  private readonly payloads = new Map<string, unknown>();
  private readonly results = new Map<string, Record<string, unknown>[]>();
  private readonly cancelled = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  async create(record: JoinJobRecord, payload: unknown): Promise<void> {
    this.records.set(record.id, { ...record });
    this.payloads.set(record.id, structuredClone(payload));
  }

  async get(id: string): Promise<JoinJobRecord | null> {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  async getPayload(id: string): Promise<unknown> {
    return this.payloads.get(id) ?? null;
  }

  async update(id: string, patch: Partial<JoinJobRecord>): Promise<JoinJobRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    Object.assign(record, patch);
    return { ...record };
  }

  async listByWorkspace(workspaceId: string): Promise<JoinJobRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn))
      .map((record) => ({ ...record }));
  }

  async saveResult(id: string, rows: Record<string, unknown>[]): Promise<void> {
    this.results.set(id, rows);
    this.payloads.delete(id);
  }

  async readResult(id: string, offset: number, limit: number): Promise<Record<string, unknown>[]> {
    return (this.results.get(id) ?? []).slice(offset, offset + limit);
  }

  async expire(id: string, ttlSeconds: number): Promise<void> {
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => this.remove(id), ttlSeconds * 1000);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  async requestCancel(id: string): Promise<void> {
    this.cancelled.add(id);
  }

  async isCancelRequested(id: string): Promise<boolean> {
    return this.cancelled.has(id);
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private remove(id: string): void {
    this.records.delete(id);
    this.payloads.delete(id);
    this.results.delete(id);
    this.cancelled.delete(id);
    this.timers.delete(id);
  }
}

/**
 * Almacén en Redis (compartido entre réplicas). El resultado es una lista: cada página se lee con LRANGE sin cargar
 * el resultado completo, y todas las claves del job expiran con EXPIRE.
 */
export class RedisJoinJobStore implements JoinJobStore {
  private readonly prefix = 'datanexus:join-job';

  constructor(private readonly redis: Redis) {}

  private key(id: string, part?: 'payload' | 'result' | 'cancel'): string {
    return part ? `${this.prefix}:${id}:${part}` : `${this.prefix}:${id}`;
  }

  private workspaceKey(workspaceId: string): string {
    return `${this.prefix}s:workspace:${workspaceId}`;
  }

  async create(record: JoinJobRecord, payload: unknown): Promise<void> {
    await this.redis
      .multi()
      .set(this.key(record.id), JSON.stringify(record))
      .set(this.key(record.id, 'payload'), JSON.stringify(payload))
      .zadd(this.workspaceKey(record.workspaceId), Date.parse(record.creadoEn), record.id)
      .exec();
  }

  async get(id: string): Promise<JoinJobRecord | null> {
    const raw = await this.redis.get(this.key(id));
    return raw ? (JSON.parse(raw) as JoinJobRecord) : null;
  }

  async getPayload(id: string): Promise<unknown> {
    const raw = await this.redis.get(this.key(id, 'payload'));
    return raw ? (JSON.parse(raw) as unknown) : null;
  }

  async update(id: string, patch: Partial<JoinJobRecord>): Promise<JoinJobRecord | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    // KEEPTTL: actualizar el estado no reinicia la expiración ya programada.
    await this.redis.set(this.key(id), JSON.stringify(next), 'KEEPTTL');
    return next;
  }

  async listByWorkspace(workspaceId: string): Promise<JoinJobRecord[]> {
    const ids = await this.redis.zrevrange(this.workspaceKey(workspaceId), 0, 199);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => this.key(id)));
    const expired = ids.filter((_, index) => raws[index] === null);
    if (expired.length) await this.redis.zrem(this.workspaceKey(workspaceId), ...expired);
    return raws.filter((raw): raw is string => raw !== null).map((raw) => JSON.parse(raw) as JoinJobRecord);
  }

  async saveResult(id: string, rows: Record<string, unknown>[]): Promise<void> {
    const key = this.key(id, 'result');
    await this.redis.del(key);
    for (let start = 0; start < rows.length; start += 1000) {
      await this.redis.rpush(key, ...rows.slice(start, start + 1000).map((row) => JSON.stringify(row)));
    }
    await this.redis.del(this.key(id, 'payload'));
  }

  async readResult(id: string, offset: number, limit: number): Promise<Record<string, unknown>[]> {
    const raws = await this.redis.lrange(this.key(id, 'result'), offset, offset + limit - 1);
    return raws.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  async expire(id: string, ttlSeconds: number): Promise<void> {
    await this.redis
      .multi()
      .expire(this.key(id), ttlSeconds)
      .expire(this.key(id, 'payload'), ttlSeconds)
      .expire(this.key(id, 'result'), ttlSeconds)
      .expire(this.key(id, 'cancel'), ttlSeconds)
      .exec();
  }

  async requestCancel(id: string): Promise<void> {
    await this.redis.set(this.key(id, 'cancel'), '1', 'EX', 86_400);
  }

  async isCancelRequested(id: string): Promise<boolean> {
    return (await this.redis.exists(this.key(id, 'cancel'))) === 1;
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
