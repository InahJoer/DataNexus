import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { DataEngineService } from '../data-engine.service.js';
import { JoinJobsService } from './join-jobs.service.js';
import type { AdapterRegistry } from '../adapters/adapter-registry.js';
import type { ConnectionsService } from '../../connections/connections.service.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { AuthenticatedRequest } from '../../auth/interfaces/authenticated-user.interface.js';
import type { CrossJoinDto } from '../dto/cross-join.dto.js';

/** Joins asíncronos con BullMQ + Redis real (REDIS_URL, en CI). */
describe.skipIf(!process.env.REDIS_URL)('Joins asíncronos con BullMQ + Redis', () => {
  const services: JoinJobsService[] = [];
  const inspector = new Redis(process.env.REDIS_URL ?? 'redis://localhost');
  const user = { id: 'u-redis', email: 'ana@corp.com', name: 'Ana', role: 'OPERADOR', workspaceId: `ws-${Date.now()}` };
  const request = { user, ip: '203.0.113.9', get: () => 'vitest' } as unknown as AuthenticatedRequest;
  const payload = {
    conexionSqlId: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
    conexionNoSqlId: 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e',
    tablaSql: 'clientes',
    coleccionNoSql: 'pedidos',
    llaveSql: 'id',
    llaveNoSql: 'cliente_id',
  } as CrossJoinDto;

  const build = (config: Record<string, unknown> = {}, delayMs = 0) => {
    const clientes = Array.from({ length: 2_500 }, (_, i) => ({ id: i, nombre: `C${i}` }));
    const pedidos = Array.from({ length: 2_500 }, (_, i) => ({ cliente_id: i, total: i }));
    const registry = {
      get: () => ({
        tipoMotor: 'POSTGRESQL',
        capabilities: { explore: true, fields: true, extract: true },
        extract: async (_c: unknown, entity: string) => {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          return entity === 'clientes' ? clientes : pedidos;
        },
      }),
    } as unknown as AdapterRegistry;
    const connections = {
      getConnectionForExploration: async (id: string) => ({ id, tipoMotor: 'POSTGRESQL', dbName: 'd', connectionString: 's' }),
    } as unknown as ConnectionsService;
    const service = new JoinJobsService(
      new DataEngineService(connections, registry),
      { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { get: (name: string) => ({ REDIS_URL: process.env.REDIS_URL, ...config })[name] } as unknown as ConfigService,
    );
    services.push(service);
    return service;
  };

  const waitFor = async (service: JoinJobsService, id: string, states: string[]) => {
    for (let i = 0; i < 400; i++) {
      const status = await service.getStatus(user as never, id);
      if (states.includes(status.estado)) return status;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('timeout');
  };

  // Cada servicio tiene un worker escuchando la misma cola (como varias réplicas): se cierran entre pruebas para
  // que el worker de una prueba no procese los jobs de la siguiente con otra configuración.
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.onModuleDestroy()));
  });

  afterAll(async () => {
    const keys = await inspector.keys('datanexus:join-job*');
    if (keys.length) await inspector.del(...keys);
    await inspector.quit();
  });

  it('procesa el job con BullMQ y pagina el resultado desde una lista de Redis', async () => {
    const service = build();
    expect(service.backend).toBe('redis');
    const job = await service.enqueue(payload, request);
    const done = await waitFor(service, job.id, ['COMPLETADO']);
    expect(done.totalFilas).toBe(2_500);

    const page = await service.getStatus(user as never, job.id, 2_400, 500);
    expect(page.resultado).toMatchObject({ total: 2_500, offset: 2_400, limit: 500 });
    expect(page.resultado!.data).toHaveLength(100);
    expect(await inspector.llen(`datanexus:join-job:${job.id}:result`)).toBe(2_500);
    // El payload (con posibles filtros) se borra al terminar; el resultado tiene TTL.
    expect(await inspector.exists(`datanexus:join-job:${job.id}:payload`)).toBe(0);
    expect(await inspector.ttl(`datanexus:join-job:${job.id}:result`)).toBeGreaterThan(3_500);
  });

  it('cancela un job en cola antes de que el worker lo tome', async () => {
    const service = build({ JOBS_CONCURRENCY: 1 }, 400);
    const first = await service.enqueue(payload, request);
    const second = await service.enqueue(payload, request);
    expect(await service.cancel(user as never, second.id)).toMatchObject({ estado: 'CANCELADO' });
    await waitFor(service, first.id, ['COMPLETADO']);
    expect((await service.getStatus(user as never, second.id)).estado).toBe('CANCELADO');
  });

  it('el estado y el resultado expiran en Redis', async () => {
    const service = build({ JOBS_RESULT_TTL_SECONDS: 1 });
    const job = await service.enqueue(payload, request);
    await waitFor(service, job.id, ['COMPLETADO']);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(service.getStatus(user as never, job.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await inspector.exists(`datanexus:join-job:${job.id}:result`)).toBe(0);
  });
});
