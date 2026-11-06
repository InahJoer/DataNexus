import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: vi.fn(function (config: Record<string, unknown>) {
    mocks.configs.push(config);
    return { on: vi.fn(), query: mocks.query, end: mocks.end };
  }),
}));

import { PostgresAdapter } from './postgres.adapter.js';
import { UnsupportedOperationError } from './data-source-adapter.interface.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';

const connection = {
  id: 'pg-1',
  tipoMotor: 'POSTGRESQL',
  dbName: 'db_from_record',
  connectionString: 'postgres://user:secret@db.internal/db_from_url?sslmode=disable',
};

describe('PostgresAdapter', () => {
  let pool: DataSourceClientPool;
  let adapter: PostgresAdapter;

  beforeEach(() => {
    mocks.configs.length = 0;
    mocks.query.mockReset().mockImplementation(async (sql: string) =>
      sql.includes('information_schema.columns')
        ? { rows: [{ name: 'id' }, { name: 'email' }] }
        : { rows: [{ schema: 'public', name: 'customers', type: 'BASE TABLE' }] },
    );
    mocks.end.mockReset().mockResolvedValue(undefined);
    pool = new DataSourceClientPool();
    adapter = new PostgresAdapter(pool);
  });

  afterEach(async () => {
    await pool.onModuleDestroy();
  });

  it('usa el dbName del registro aunque la URL traiga otra base, con timeouts del motor', async () => {
    await expect(adapter.listObjects(connection)).resolves.toEqual([
      { schema: 'public', name: 'customers', type: 'TABLE' },
    ]);
    expect(mocks.configs[0]).toMatchObject({
      connectionString: 'postgres://user:secret@db.internal/db_from_record?sslmode=disable',
      connectionTimeoutMillis: 8_000,
      statement_timeout: 8_000,
      max: 4,
    });
  });

  it('lista campos con parámetros y reutiliza el pool', async () => {
    await adapter.listObjects(connection);
    await expect(adapter.listFields(connection, 'customers', 'public')).resolves.toEqual(['id', 'email']);
    expect(mocks.query.mock.calls[1][1]).toEqual(['customers', 'public']);
    expect(mocks.configs).toHaveLength(1);

    await pool.invalidate('pg-1');
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('declara que aún no extrae datos', async () => {
    expect(adapter.capabilities.extract).toBe(false);
    await expect(adapter.extract()).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it('rechaza cadenas que no son de PostgreSQL', async () => {
    await expect(adapter.listObjects({ ...connection, connectionString: 'mysql://x' })).rejects.toThrow(
      'Invalid PostgreSQL connection configuration',
    );
  });
});
