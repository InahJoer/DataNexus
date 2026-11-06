import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

export const JOIN_JOBS_QUEUE = 'datanexus-join-jobs';

/** Ejecuta los jobs encolados con una concurrencia máxima por instancia. */
export interface JoinJobRunner {
  enqueue(jobId: string): Promise<void>;
  /** Quita un job que aún no empezó. Devuelve false si ya estaba en proceso o terminado. */
  removeQueued(jobId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Cola local (sin Redis): FIFO con concurrencia limitada en el mismo proceso. */
export class InMemoryJoinJobRunner implements JoinJobRunner {
  private readonly waiting: string[] = [];
  private running = 0;
  private closed = false;

  constructor(
    private readonly concurrency: number,
    private readonly process: (jobId: string) => Promise<void>,
  ) {}

  async enqueue(jobId: string): Promise<void> {
    this.waiting.push(jobId);
    this.pump();
  }

  async removeQueued(jobId: string): Promise<boolean> {
    const index = this.waiting.indexOf(jobId);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.waiting.length = 0;
  }

  private pump(): void {
    while (!this.closed && this.running < this.concurrency && this.waiting.length) {
      const jobId = this.waiting.shift()!;
      this.running += 1;
      // setImmediate: la petición que encoló el job responde antes de que empiece a procesarse.
      setImmediate(() => {
        void this.process(jobId)
          .catch(() => undefined)
          .finally(() => {
            this.running -= 1;
            this.pump();
          });
      });
    }
  }
}

/**
 * Cola BullMQ sobre Redis: los jobs sobreviven a reinicios y se reparten entre réplicas. Cada instancia tiene un
 * Worker con la concurrencia configurada; el estado y el resultado los guarda RedisJoinJobStore.
 */
export class BullMqJoinJobRunner implements JoinJobRunner {
  private readonly queue: Queue;
  private readonly worker: Worker;
  private readonly connections: Redis[] = [];

  constructor(redisUrl: string, concurrency: number, process: (jobId: string) => Promise<void>) {
    // BullMQ necesita conexiones propias para la cola y el worker (el worker usa comandos bloqueantes).
    const connection = () => {
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
      redis.on('error', () => undefined);
      this.connections.push(redis);
      return redis;
    };
    this.queue = new Queue(JOIN_JOBS_QUEUE, { connection: connection() });
    this.worker = new Worker(JOIN_JOBS_QUEUE, async (job) => process(String(job.data.jobId)), {
      connection: connection(),
      concurrency,
    });
    this.worker.on('error', () => undefined);
  }

  async enqueue(jobId: string): Promise<void> {
    await this.queue.add('cross-join', { jobId }, { jobId, removeOnComplete: true, removeOnFail: true, attempts: 1 });
  }

  async removeQueued(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (state !== 'waiting' && state !== 'delayed' && state !== 'prioritized') return false;
    await job.remove();
    return true;
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await Promise.all(this.connections.map((redis) => redis.quit().catch(() => undefined)));
  }
}
