import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSourceClientPool } from './data-source-client-pool.js';

const key = (connectionId: string, connectionString = 'dsn-1', variant?: string) => ({
  connectionId,
  connectionString,
  variant,
});

function fakeClient() {
  return { closed: false };
}

describe('DataSourceClientPool', () => {
  let pool: DataSourceClientPool;
  afterEach(async () => {
    await pool?.onModuleDestroy();
  });

  it('reutiliza el cliente de la misma conexión y credenciales', async () => {
    pool = new DataSourceClientPool();
    const create = vi.fn(async () => fakeClient());
    const dispose = vi.fn(async () => undefined);

    const first = await pool.withClient(key('c1'), create, dispose, async (client) => client);
    const second = await pool.withClient(key('c1'), create, dispose, async (client) => client);

    expect(first).toBe(second);
    expect(create).toHaveBeenCalledOnce();
    expect(pool.stats()).toEqual({ size: 1, connections: ['c1'] });
  });

  it('crea un solo cliente aunque lleguen peticiones simultáneas', async () => {
    pool = new DataSourceClientPool();
    const create = vi.fn(() => new Promise<object>((resolve) => setTimeout(() => resolve(fakeClient()), 10)));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => pool.withClient(key('c1'), create, async () => undefined, async (client) => client)),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(new Set(results).size).toBe(1);
  });

  it('separa clientes si cambian las credenciales o la base de datos', async () => {
    pool = new DataSourceClientPool();
    const create = vi.fn(async () => fakeClient());
    await pool.withClient(key('c1', 'dsn-1'), create, async () => undefined, async () => undefined);
    await pool.withClient(key('c1', 'dsn-2'), create, async () => undefined, async () => undefined);
    await pool.withClient(key('c1', 'dsn-2', 'otra-db'), create, async () => undefined, async () => undefined);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('no guarda en caché un cliente cuya creación falló', async () => {
    pool = new DataSourceClientPool();
    const create = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue(fakeClient());
    await expect(pool.withClient(key('c1'), create, async () => undefined, async () => 'ok')).rejects.toThrow('ECONNREFUSED');
    await expect(pool.withClient(key('c1'), create, async () => undefined, async () => 'ok')).resolves.toBe('ok');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('invalidate cierra solo los clientes de esa conexión', async () => {
    pool = new DataSourceClientPool();
    const disposed: string[] = [];
    for (const id of ['c1', 'c2']) {
      await pool.withClient(key(id), async () => ({ id }), async (client) => void disposed.push(client.id), async () => undefined);
    }
    await pool.invalidate('c1');
    expect(disposed).toEqual(['c1']);
    expect(pool.stats().connections).toEqual(['c2']);
  });

  it('cierra los clientes inactivos tras el TTL, pero no los que están en uso', async () => {
    let now = 0;
    pool = new DataSourceClientPool(1_000, 50, () => now);
    const dispose = vi.fn(async () => undefined);
    await pool.withClient(key('idle'), async () => fakeClient(), dispose, async () => undefined);

    let release!: () => void;
    const busy = pool.withClient(
      key('busy'),
      async () => fakeClient(),
      dispose,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    now = 5_000;
    expect(await pool.sweep()).toBe(1);
    expect(pool.stats().connections).toEqual(['busy']);

    release();
    await busy;
    now = 10_000;
    expect(await pool.sweep()).toBe(1);
    expect(pool.stats().size).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('respeta el máximo de entradas cerrando las menos usadas', async () => {
    let now = 0;
    pool = new DataSourceClientPool(60_000, 2, () => now);
    const disposed: string[] = [];
    for (const id of ['a', 'b', 'c']) {
      now += 1;
      await pool.withClient(key(id), async () => ({ id }), async (client) => void disposed.push(client.id), async () => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toEqual(['a']);
    expect(pool.stats().connections.sort()).toEqual(['b', 'c']);
  });

  it('al apagar la aplicación cierra todos los clientes', async () => {
    pool = new DataSourceClientPool();
    const dispose = vi.fn(async () => undefined);
    await pool.withClient(key('c1'), async () => fakeClient(), dispose, async () => undefined);
    await pool.withClient(key('c2'), async () => fakeClient(), dispose, async () => undefined);
    await pool.onModuleDestroy();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(pool.stats().size).toBe(0);
  });

  it('un fallo al cerrar no impide cerrar el resto', async () => {
    pool = new DataSourceClientPool();
    const dispose = vi.fn().mockRejectedValueOnce(new Error('ya cerrado')).mockResolvedValue(undefined);
    await pool.withClient(key('c1'), async () => fakeClient(), dispose, async () => undefined);
    await pool.withClient(key('c2'), async () => fakeClient(), dispose, async () => undefined);
    await expect(pool.onModuleDestroy()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
