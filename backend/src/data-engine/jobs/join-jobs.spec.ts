import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { BadRequestException, ConflictException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DataEngineService } from '../data-engine.service.js';
import { JoinJobsService } from './join-jobs.service.js';
import type { AdapterRegistry } from '../adapters/adapter-registry.js';
import type { ConnectionsService } from '../../connections/connections.service.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { AuthenticatedRequest } from '../../auth/interfaces/authenticated-user.interface.js';
import type { CrossJoinDto } from '../dto/cross-join.dto.js';

/** Joins asíncronos con la cola en memoria (issue #33). El mismo flujo con BullMQ + Redis está en el spec de integración. */
const SQL = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
const NOSQL = 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e';

const payload = (extra: Record<string, unknown> = {}) =>
  ({
    conexionSqlId: SQL,
    conexionNoSqlId: NOSQL,
    tablaSql: 'clientes',
    coleccionNoSql: 'pedidos',
    llaveSql: 'id',
    llaveNoSql: 'cliente_id',
    ...extra,
  }) as CrossJoinDto;

const request = (user: Partial<AuthenticatedRequest['user']> = {}) =>
  ({
    user: { id: 'u1', email: 'ana@corp.com', name: 'Ana', role: 'OPERADOR', workspaceId: 'ws-1', ...user },
    ip: '203.0.113.9',
    get: () => 'vitest',
  }) as unknown as AuthenticatedRequest;

const services: JoinJobsService[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(services.splice(0).map((service) => service.onModuleDestroy()));
});

function setup(rows = 100, config: Record<string, unknown> = {}, extract?: (entity: string) => Promise<Record<string, any>[]>) {
  const clientes = Array.from({ length: rows }, (_, i) => ({ id: i, nombre: `Cliente ${i}`, email: `c${i}@corp.com` }));
  const pedidos = Array.from({ length: rows }, (_, i) => ({ cliente_id: i, total: i % 100 }));
  const extractFn = vi.fn(
    extract ?? (async (entity: string) => (entity === 'clientes' ? clientes : pedidos)),
  );
  const registry = {
    get: vi.fn(() => ({
      tipoMotor: 'POSTGRESQL',
      capabilities: { explore: true, fields: true, extract: true },
      extract: (_connection: unknown, entity: string) => extractFn(entity),
    })),
  } as unknown as AdapterRegistry;
  const connections = {
    getConnectionForExploration: vi.fn(async (id: string) => ({ id, tipoMotor: 'POSTGRESQL', dbName: 'd', connectionString: 's' })),
  } as unknown as ConnectionsService;
  const engine = new DataEngineService(connections, registry);
  const record = vi.fn().mockResolvedValue(undefined);
  const service = new JoinJobsService(engine, { record } as unknown as AuditService, {
    get: (name: string) => config[name],
  } as unknown as ConfigService);
  services.push(service);
  return { service, engine, record, extractFn };
}

async function waitFor(service: JoinJobsService, jobId: string, states: string[], user = request().user, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const status = await service.getStatus(user, jobId);
    if (states.includes(status.estado)) return status;
    if (Date.now() - started > timeoutMs) throw new Error(`El job sigue en ${status.estado}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Ciclo de vida de un join asíncrono', () => {
  it('responde enseguida EN_COLA y luego entrega el resultado paginado, enmascarado y auditado', async () => {
    const { service, record } = setup(120);
    expect(service.backend).toBe('memoria');
    const job = await service.enqueue(payload(), request({ role: 'LECTOR' }));
    expect(job).toMatchObject({ estado: 'EN_COLA', progreso: 0, descripcion: 'clientes x pedidos', creadoPor: 'ana@corp.com' });
    expect(job).not.toHaveProperty('ip');

    const lector = request({ role: 'LECTOR' }).user;
    const done = await waitFor(service, job.id, ['COMPLETADO'], lector);
    expect(done).toMatchObject({ progreso: 100, totalFilas: 120, truncado: false });
    expect(Date.parse(done.expiraEn!) - Date.parse(done.terminadoEn!)).toBe(3600 * 1000);

    const page = await service.getStatus(lector, job.id, 100, 50);
    expect(page.resultado).toMatchObject({ total: 120, offset: 100, limit: 50 });
    expect(page.resultado!.data).toHaveLength(20);
    // Rol LECTOR: el resultado se guarda ya enmascarado.
    expect(page.resultado!.data[0].email).not.toMatch(/^c\d+@corp\.com$/);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'EXECUTE_JOIN', outcome: 'SUCCESS', ipAddress: '203.0.113.9', details: expect.objectContaining({ totalFilas: 120 }) }),
    );
  });

  it('una actualización de progreso lenta nunca sobrescribe el estado final', async () => {
    const { service } = setup(60_000);
    const update = service.store.update.bind(service.store);
    let slowWrites = 0;
    vi.spyOn(service.store, 'update').mockImplementation(async (id, patch) => {
      // Simula Redis lento solo para el progreso: sin la espera, llegaría después de COMPLETADO.
      if ('progreso' in patch && !('estado' in patch)) {
        slowWrites += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return update(id, patch);
    });
    const job = await service.enqueue(payload(), request());
    await waitFor(service, job.id, ['COMPLETADO']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(slowWrites).toBeGreaterThan(0);
    expect(await service.getStatus(request().user, job.id)).toMatchObject({ estado: 'COMPLETADO', progreso: 100 });
  });

  it('valida el payload al encolar (400) en lugar de fallar después', async () => {
    const { service } = setup();
    await expect(service.enqueue(payload({ llaveNoSql: undefined }), request())).rejects.toBeInstanceOf(BadRequestException);
    expect(await service.list(request().user)).toEqual([]);
  });

  it('un error queda como FALLIDO con un mensaje seguro', async () => {
    const tooBig = setup(10, {}, async () => {
      throw new HttpException('La fuente supera el máximo de 10000 filas configurado', HttpStatus.PAYLOAD_TOO_LARGE);
    });
    const job = await tooBig.service.enqueue(payload(), request());
    expect(await waitFor(tooBig.service, job.id, ['FALLIDO'])).toMatchObject({ error: 'La fuente supera el máximo de 10000 filas configurado' });
    expect(tooBig.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'EXECUTE_JOIN', outcome: 'FAILURE' }));

    const leak = setup(10, {}, async () => {
      throw new Error('password authentication failed for user "root" at 10.0.0.5');
    });
    const failed = await waitFor(leak.service, (await leak.service.enqueue(payload(), request())).id, ['FALLIDO']);
    expect(failed.error).toBe('No fue posible extraer datos de la fuente externa');
    expect(failed.error).not.toContain('10.0.0.5');
  });
});

describe('No bloquea el event loop (RNF-04)', () => {
  it('mientras corre un join de 200.000 x 200.000 filas el servidor sigue respondiendo', async () => {
    vi.stubEnv('DATA_ENGINE_MAX_JOIN_ROWS', '1000000');
    const { service, engine } = setup(200_000);

    // Referencia: el mismo join síncrono deja al event loop sin responder durante todo el cálculo.
    let syncMaxGap = 0;
    let last = performance.now();
    const syncTicker = setInterval(() => {
      const now = performance.now();
      syncMaxGap = Math.max(syncMaxGap, now - last);
      last = now;
    }, 5);
    await engine.executeCrossJoin(payload({ limit: 10 }), request().user);
    // Deja que el ticker corra una vez más para registrar la pausa que provocó el join síncrono.
    await new Promise((resolve) => setTimeout(resolve, 30));
    clearInterval(syncTicker);

    let maxGap = 0;
    last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const job = await service.enqueue(payload(), request());
    const done = await waitFor(service, job.id, ['COMPLETADO']);
    clearInterval(ticker);

    console.log(`Pausa máx. del event loop: join síncrono ${syncMaxGap.toFixed(0)} ms, job asíncrono ${maxGap.toFixed(0)} ms`);
    expect(done.totalFilas).toBe(200_000);
    expect(maxGap).toBeLessThan(syncMaxGap);
    expect(maxGap).toBeLessThan(150);
  }, 60_000);
});

describe('Cancelación', () => {
  it('cancela un job en cola: nunca se ejecuta', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, extractFn } = setup(10, { JOBS_CONCURRENCY: 1 }, async (entity) => {
      await gate;
      return entity === 'clientes' ? [{ id: 1 }] : [{ cliente_id: 1 }];
    });
    const first = await service.enqueue(payload(), request());
    const second = await service.enqueue(payload(), request());
    await waitFor(service, first.id, ['EN_PROCESO']);

    expect(await service.cancel(request().user, second.id)).toMatchObject({ estado: 'CANCELADO' });
    release();
    await waitFor(service, first.id, ['COMPLETADO']);
    expect(extractFn).toHaveBeenCalledTimes(2); // solo las dos fuentes del primer job
    expect((await service.getStatus(request().user, second.id)).estado).toBe('CANCELADO');
  });

  it('cancela un job en proceso: se detiene en la siguiente pausa', async () => {
    vi.stubEnv('DATA_ENGINE_MAX_JOIN_ROWS', '1000000');
    const { service } = setup(300_000);
    const job = await service.enqueue(payload(), request());
    await waitFor(service, job.id, ['EN_PROCESO']);
    await service.cancel(request().user, job.id);
    const final = await waitFor(service, job.id, ['CANCELADO', 'COMPLETADO']);
    expect(final.estado).toBe('CANCELADO');
    expect(final.resultado).toBeUndefined();
  }, 60_000);

  it('un job terminado no se puede cancelar (409)', async () => {
    const { service } = setup(5);
    const job = await service.enqueue(payload(), request());
    await waitFor(service, job.id, ['COMPLETADO']);
    await expect(service.cancel(request().user, job.id)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('Límites y acceso', () => {
  it('limita los jobs activos por workspace (429) sin afectar a otros workspaces', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service } = setup(1, { JOBS_MAX_ACTIVE_PER_WORKSPACE: 2 }, async () => {
      await gate;
      return [];
    });
    await service.enqueue(payload(), request());
    await service.enqueue(payload(), request());
    await expect(service.enqueue(payload(), request())).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    await expect(service.enqueue(payload(), request({ workspaceId: 'ws-2' }))).resolves.toMatchObject({ estado: 'EN_COLA' });
    release();
  });

  it('solo el autor y los ADMIN del mismo workspace ven el job', async () => {
    const { service } = setup(5);
    const job = await service.enqueue(payload(), request());
    await expect(service.getStatus(request({ id: 'otro' }).user, job.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getStatus(request({ id: 'admin', role: 'ADMIN', workspaceId: 'ws-2' }).user, job.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getStatus(request({ id: 'admin', role: 'ADMIN' }).user, job.id)).resolves.toMatchObject({ id: job.id });
    expect(await service.list(request({ id: 'otro' }).user)).toEqual([]);
    expect(await service.list(request({ id: 'admin', role: 'ADMIN' }).user)).toHaveLength(1);
  });

  it('el resultado y el estado expiran solos tras JOBS_RESULT_TTL_SECONDS', async () => {
    const { service } = setup(5, { JOBS_RESULT_TTL_SECONDS: 1 });
    const job = await service.enqueue(payload(), request());
    await waitFor(service, job.id, ['COMPLETADO']);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await expect(service.getStatus(request().user, job.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
