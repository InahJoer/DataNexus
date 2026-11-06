import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgresAdapter } from '../adapters/postgres.adapter.js';
import { DataSourceClientPool } from './data-source-client-pool.js';

/**
 * Pool de clientes contra PostgreSQL real (RNF-10): reutiliza conexiones, las cierra al invalidar y no deja
 * ninguna abierta al apagar la aplicación. Requiere DATABASE_URL (se ejecuta en CI).
 */
describe.skipIf(!process.env.DATABASE_URL)('DataSourceClientPool con PostgreSQL real', () => {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/x');
  url.search = '';
  const appName = `datanexus-pool-${Date.now()}`;
  url.searchParams.set('application_name', appName);
  const connection = {
    id: 'pool-it',
    tipoMotor: 'POSTGRESQL',
    dbName: url.pathname.slice(1),
    connectionString: url.toString(),
  };
  const monitor = new Client({ connectionString: process.env.DATABASE_URL?.split('?')[0] });

  const openConnections = async () => {
    const result = await monitor.query<{ count: string }>(
      'SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = $1',
      [appName],
    );
    return Number(result.rows[0].count);
  };

  beforeAll(async () => {
    await monitor.connect();
  });

  afterAll(async () => {
    await monitor.end();
  });

  it('reutiliza las conexiones entre operaciones y las cierra al invalidar y al apagar', async () => {
    const pool = new DataSourceClientPool();
    const adapter = new PostgresAdapter(pool);

    for (let i = 0; i < 5; i++) {
      const objects = await adapter.listObjects(connection);
      expect(objects.some((object) => object.name === 'ConexionDB')).toBe(true);
    }
    await expect(adapter.listFields(connection, 'Workspace', 'public')).resolves.toContain('nombreEmpresa');
    // Cinco exploraciones secuenciales usan una sola conexión física del pool.
    expect(await openConnections()).toBe(1);

    // pool.end() resuelve al cerrar el socket, pero PostgreSQL retira el proceso de pg_stat_activity unos
    // milisegundos después; en CI (más rápido) la consulta inmediata aún lo ve. Se espera a que desaparezca.
    const waitUntilClosed = { timeout: 5_000, interval: 50 };

    await pool.invalidate('pool-it');
    await expect.poll(openConnections, waitUntilClosed).toBe(0);

    await Promise.all(Array.from({ length: 3 }, () => adapter.listObjects(connection)));
    expect(await openConnections()).toBeGreaterThan(0);

    await pool.onModuleDestroy();
    await expect.poll(openConnections, waitUntilClosed).toBe(0);
  });
});
