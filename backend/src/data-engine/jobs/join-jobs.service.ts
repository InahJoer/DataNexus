import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { AuditService } from '../../audit/audit.service.js';
import type { AuthenticatedRequest, AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface.js';
import { DataEngineService } from '../data-engine.service.js';
import { buildDataAccessAuditEvent } from '../data-access-audit.js';
import type { CrossJoinDto } from '../dto/cross-join.dto.js';
import { describeJoinPlan } from '../join/join-plan.js';
import { resolveJoinPlan } from '../join/resolve-join-plan.js';
import {
  ACTIVE_STATES,
  InMemoryJoinJobStore,
  RedisJoinJobStore,
  type JoinJobRecord,
  type JoinJobStore,
} from './join-job.store.js';
import { BullMqJoinJobRunner, InMemoryJoinJobRunner, type JoinJobRunner } from './join-job.runner.js';

const DEFAULTS = { concurrency: 2, maxActivePerWorkspace: 3, resultTtlSeconds: 3600 };
/** Cada cuánto mira un job en proceso si alguien pidió cancelarlo (también entre réplicas, vía Redis). */
const CANCEL_POLL_MS = 500;

export interface JoinJobStatus extends Omit<JoinJobRecord, 'userId' | 'userName' | 'role' | 'ip' | 'userAgent'> {
  creadoPor: string;
  resultado?: { total: number; offset: number; limit: number; data: Record<string, unknown>[] };
}

class JobCancelledError extends Error {}

/**
 * Joins asíncronos (RNF-04, issue #33): `POST /engine/jobs` encola el cross-join y responde enseguida con el id;
 * un worker lo ejecuta cediendo el event loop, con progreso, cancelación y límite de jobs activos por workspace.
 * El resultado (ya enmascarado según el rol de quien lo pidió) se pagina y expira tras JOBS_RESULT_TTL_SECONDS.
 *
 * Con REDIS_URL usa BullMQ + Redis (compartido entre réplicas); sin él, una cola en memoria con la misma API.
 */
@Injectable()
export class JoinJobsService implements OnModuleDestroy {
  private readonly logger = new Logger(JoinJobsService.name);
  readonly store: JoinJobStore;
  private readonly runner: JoinJobRunner;
  private readonly maxActivePerWorkspace: number;
  readonly resultTtlSeconds: number;
  readonly backend: 'redis' | 'memoria';

  constructor(
    private readonly engine: DataEngineService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    const number = (name: string, fallback: number) => {
      const value = Number(config.get(name));
      return Number.isSafeInteger(value) && value > 0 ? value : fallback;
    };
    const concurrency = number('JOBS_CONCURRENCY', DEFAULTS.concurrency);
    this.maxActivePerWorkspace = number('JOBS_MAX_ACTIVE_PER_WORKSPACE', DEFAULTS.maxActivePerWorkspace);
    this.resultTtlSeconds = number('JOBS_RESULT_TTL_SECONDS', DEFAULTS.resultTtlSeconds);
    const redisUrl = config.get<string>('REDIS_URL');
    const process = (jobId: string) => this.process(jobId);

    if (redisUrl) {
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
      redis.on('error', (error) => this.logger.warn(`Redis de jobs no disponible: ${error.message}`));
      this.store = new RedisJoinJobStore(redis);
      this.runner = new BullMqJoinJobRunner(redisUrl, concurrency, process);
      this.backend = 'redis';
    } else {
      this.store = new InMemoryJoinJobStore();
      this.runner = new InMemoryJoinJobRunner(concurrency, process);
      this.backend = 'memoria';
      this.logger.log('Joins asíncronos con cola en memoria (sin REDIS_URL): use Redis con varias réplicas');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.runner.close();
    await this.store.close();
  }

  /** Valida el payload, aplica el límite por workspace y encola el job. */
  async enqueue(payload: CrossJoinDto, request: AuthenticatedRequest): Promise<JoinJobStatus> {
    const user = request.user;
    // Un payload inválido responde 400 ahora, no cuando el worker lo procese.
    const plan = resolveJoinPlan(payload);

    const active = (await this.store.listByWorkspace(user.workspaceId)).filter((job) => ACTIVE_STATES.includes(job.estado));
    if (active.length >= this.maxActivePerWorkspace) {
      throw new HttpException(
        `El workspace ya tiene ${active.length} joins en cola o en proceso (máximo ${this.maxActivePerWorkspace}). ` +
          'Espere a que terminen o cancele alguno.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const record: JoinJobRecord = {
      id: randomUUID(),
      workspaceId: user.workspaceId,
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      estado: 'EN_COLA',
      progreso: 0,
      descripcion: describeJoinPlan(plan),
      creadoEn: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.get?.('user-agent') ?? undefined,
    };
    await this.store.create(record, payload);
    // Si el servidor se cae antes de procesarlo, el job no queda para siempre.
    await this.store.expire(record.id, this.resultTtlSeconds * 24);
    await this.runner.enqueue(record.id);
    return this.toStatus(record);
  }

  async getStatus(user: AuthenticatedUser, jobId: string, offset = 0, limit = 50): Promise<JoinJobStatus> {
    const record = await this.findVisible(user, jobId);
    const status = this.toStatus(record);
    if (record.estado === 'COMPLETADO') {
      status.resultado = {
        total: record.totalFilas ?? 0,
        offset,
        limit,
        data: await this.store.readResult(jobId, offset, limit),
      };
    }
    return status;
  }

  async list(user: AuthenticatedUser): Promise<JoinJobStatus[]> {
    const jobs = await this.store.listByWorkspace(user.workspaceId);
    return jobs.filter((job) => this.canSee(user, job)).map((job) => this.toStatus(job));
  }

  /** Cancela un job en cola (no llega a ejecutarse) o en proceso (se detiene en la siguiente pausa del join). */
  async cancel(user: AuthenticatedUser, jobId: string): Promise<JoinJobStatus> {
    const record = await this.findVisible(user, jobId);
    if (!ACTIVE_STATES.includes(record.estado)) {
      throw new ConflictException(`El job ya terminó (${record.estado}) y no se puede cancelar`);
    }
    await this.store.requestCancel(jobId);
    if (record.estado === 'EN_COLA' && (await this.runner.removeQueued(jobId))) {
      const cancelled = await this.finish(jobId, { estado: 'CANCELADO' });
      return this.toStatus(cancelled ?? record);
    }
    return this.toStatus((await this.store.get(jobId)) ?? record);
  }

  /** Lo ejecuta el worker: corre el join, guarda el resultado y programa su expiración. */
  async process(jobId: string): Promise<void> {
    const record = await this.store.get(jobId);
    if (!record || record.estado !== 'EN_COLA') return;
    if (await this.store.isCancelRequested(jobId)) {
      await this.finish(jobId, { estado: 'CANCELADO' });
      return;
    }
    const payload = (await this.store.getPayload(jobId)) as CrossJoinDto | null;
    if (!payload) {
      await this.finish(jobId, { estado: 'FALLIDO', error: 'El job expiró antes de procesarse' });
      return;
    }

    await this.store.update(jobId, { estado: 'EN_PROCESO', iniciadoEn: new Date().toISOString() });
    const controller = new AbortController();
    const poll = setInterval(() => {
      void this.store.isCancelRequested(jobId).then((cancelled) => {
        if (cancelled) controller.abort(new JobCancelledError('cancelado'));
      });
    }, CANCEL_POLL_MS);
    poll.unref?.();

    let lastReported = 0;
    const onProgress = (fraction: number) => {
      const progreso = Math.min(99, Math.floor(fraction * 100));
      if (progreso >= lastReported + 5) {
        lastReported = progreso;
        void this.store.update(jobId, { progreso });
      }
    };

    const user = this.userOf(record);
    const request = this.requestOf(record);
    try {
      const { rows, truncated } = await this.engine.runCrossJoinJob(payload, user, { signal: controller.signal, onProgress });
      if (await this.store.isCancelRequested(jobId)) throw new JobCancelledError('cancelado');
      await this.store.saveResult(jobId, rows);
      await this.finish(jobId, { estado: 'COMPLETADO', progreso: 100, totalFilas: rows.length, truncado: truncated });
      await this.recordAudit(request, payload, { totalFilas: rows.length });
    } catch (error) {
      if (error instanceof JobCancelledError || controller.signal.aborted) {
        await this.finish(jobId, { estado: 'CANCELADO' });
        return;
      }
      await this.finish(jobId, { estado: 'FALLIDO', error: this.describeError(error) });
      await this.recordAudit(request, payload, { error });
    } finally {
      clearInterval(poll);
    }
  }

  private async finish(jobId: string, patch: Partial<JoinJobRecord>): Promise<JoinJobRecord | null> {
    const terminadoEn = new Date();
    const expiraEn = new Date(terminadoEn.getTime() + this.resultTtlSeconds * 1000).toISOString();
    const record = await this.store.update(jobId, { ...patch, terminadoEn: terminadoEn.toISOString(), expiraEn });
    await this.store.expire(jobId, this.resultTtlSeconds);
    return record;
  }

  private async recordAudit(request: AuthenticatedRequest, payload: CrossJoinDto, result: { totalFilas?: number; error?: unknown }) {
    try {
      await this.audit.record(buildDataAccessAuditEvent('EXECUTE_JOIN', request, payload, result));
    } catch {
      this.logger.warn('No se pudo registrar en la bitácora el resultado de un join asíncrono');
    }
  }

  private async findVisible(user: AuthenticatedUser, jobId: string): Promise<JoinJobRecord> {
    const record = await this.store.get(jobId);
    // Un job de otro workspace (o de otro usuario, salvo para ADMIN) responde igual que uno inexistente.
    if (!record || !this.canSee(user, record)) throw new NotFoundException('Job no encontrado o expirado');
    return record;
  }

  private canSee(user: AuthenticatedUser, record: JoinJobRecord): boolean {
    return record.workspaceId === user.workspaceId && (record.userId === user.id || user.role === 'ADMIN');
  }

  private toStatus(record: JoinJobRecord): JoinJobStatus {
    const { userId: _userId, userName: _userName, role: _role, ip: _ip, userAgent: _userAgent, userEmail, ...rest } = record;
    return { ...rest, userEmail, creadoPor: userEmail };
  }

  private userOf(record: JoinJobRecord): AuthenticatedUser {
    return {
      id: record.userId,
      email: record.userEmail,
      name: record.userName,
      role: record.role,
      workspaceId: record.workspaceId,
    } as AuthenticatedUser;
  }

  private requestOf(record: JoinJobRecord): AuthenticatedRequest {
    return {
      user: this.userOf(record),
      ip: record.ip,
      get: (header: string) => (header.toLowerCase() === 'user-agent' ? record.userAgent : undefined),
    } as unknown as AuthenticatedRequest;
  }

  /** Mensaje seguro para el usuario: el de los errores HTTP propios; nunca el del driver (puede tener hosts o datos). */
  private describeError(error: unknown): string {
    if (error instanceof HttpException) return error.message;
    return 'No fue posible completar el join';
  }
}
