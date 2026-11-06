import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ApiUsageInterceptor } from './api-usage.interceptor.js';
import { UsageMeterService } from './usage-meter.service.js';

/** Extrae los valores interpolados de cada `$executeRaw` (TemplateStringsArray + valores). */
function setup(executeRaw = vi.fn().mockResolvedValue(1)) {
  const prisma = { $executeRaw: executeRaw } as unknown as PrismaService;
  const meter = new UsageMeterService(prisma);
  const calls = () => executeRaw.mock.calls.map(([, ...values]) => values);
  return { meter, executeRaw, calls };
}

const NOV_6 = new Date('2026-11-06T15:00:00Z');
const NOV_7 = new Date('2026-11-07T00:30:00Z');

describe('UsageMeterService (issue #40)', () => {
  it('acumula por workspace y día UTC y vuelca con un incremento por clave', async () => {
    const { meter, calls } = setup();
    meter.recordApiRequest('ws-1', NOV_6);
    meter.recordApiRequest('ws-1', NOV_6);
    meter.recordBytesProcessed('ws-1', 2_048.4, NOV_6);
    meter.recordApiRequest('ws-1', NOV_7);
    meter.recordApiRequest('ws-2', NOV_6);

    await meter.flush();

    expect(calls()).toEqual([
      ['ws-1', '2026-11-06', 2, 2048n],
      ['ws-1', '2026-11-07', 1, 0n],
      ['ws-2', '2026-11-06', 1, 0n],
    ]);
    expect(meter.pendingFor('ws-1')).toEqual([]);
  });

  it('usa INSERT ... ON CONFLICT para sumar de forma atómica entre réplicas', async () => {
    const { meter, executeRaw } = setup();
    meter.recordApiRequest('ws-1', NOV_6);
    await meter.flush();

    const sql = (executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('ON CONFLICT ("workspaceId", "dia") DO UPDATE');
    expect(sql).toContain('"solicitudesApi" = "WorkspaceUsageDaily"."solicitudesApi" + EXCLUDED."solicitudesApi"');
  });

  it('ignora bytes no válidos', () => {
    const { meter } = setup();
    meter.recordBytesProcessed('ws-1', 0, NOV_6);
    meter.recordBytesProcessed('ws-1', -5, NOV_6);
    meter.recordBytesProcessed('ws-1', Number.NaN, NOV_6);
    expect(meter.pendingFor('ws-1')).toEqual([]);
  });

  it('devuelve los contadores al buffer si la base falla y los suma a lo nuevo', async () => {
    const executeRaw = vi.fn().mockRejectedValueOnce(new Error('conexión perdida')).mockResolvedValue(1);
    const { meter, calls } = setup(executeRaw);
    meter.recordApiRequest('ws-1', NOV_6);
    await meter.flush();
    meter.recordApiRequest('ws-1', NOV_6);

    expect(meter.pendingFor('ws-1')).toEqual([{ workspaceId: 'ws-1', day: '2026-11-06', apiRequests: 2, bytesProcessed: 0 }]);
    await meter.flush();
    expect(calls().at(-1)).toEqual(['ws-1', '2026-11-06', 2, 0n]);
  });

  it('descarta el uso de un workspace eliminado (violación de FK)', async () => {
    const fk = new Prisma.PrismaClientKnownRequestError('fk', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: '23503' },
    });
    const { meter } = setup(vi.fn().mockRejectedValue(fk));
    meter.recordApiRequest('ws-borrado', NOV_6);
    await meter.flush();
    expect(meter.pendingFor('ws-borrado')).toEqual([]);
  });

  it('vuelca lo pendiente al apagar la aplicación', async () => {
    const { meter, executeRaw } = setup();
    meter.onModuleInit();
    meter.recordApiRequest('ws-1', NOV_6);
    await meter.onModuleDestroy();
    expect(executeRaw).toHaveBeenCalledOnce();
  });
});

describe('ApiUsageInterceptor', () => {
  const context = (user?: object, type = 'http') =>
    ({
      getType: () => type,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  it('cuenta solo solicitudes HTTP autenticadas', () => {
    const recordApiRequest = vi.fn();
    const interceptor = new ApiUsageInterceptor({ recordApiRequest } as unknown as UsageMeterService);
    const next = { handle: () => of('ok') };

    interceptor.intercept(context({ id: 'u1', workspaceId: 'ws-1' }), next);
    interceptor.intercept(context(undefined), next);
    interceptor.intercept(context({ id: 'u1', workspaceId: 'ws-1' }, 'rpc'), next);

    expect(recordApiRequest).toHaveBeenCalledTimes(1);
    expect(recordApiRequest).toHaveBeenCalledWith('ws-1');
  });
});
