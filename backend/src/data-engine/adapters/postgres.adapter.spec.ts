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

import { BadRequestException } from '@nestjs/common';
import { PostgresAdapter, buildPostgresSelect, quotePostgresIdentifier } from './postgres.adapter.js';
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

  it('declara que extrae datos y valida los nombres antes de consultar', async () => {
    expect(adapter.capabilities.extract).toBe(true);
    await expect(adapter.extract(connection, '')).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.extract(connection, 'x'.repeat(64))).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.extract(connection, 'clientes', { schema: 'a\0b' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rechaza cadenas que no son de PostgreSQL', async () => {
    await expect(adapter.listObjects({ ...connection, connectionString: 'mysql://x' })).rejects.toThrow(
      'Invalid PostgreSQL connection configuration',
    );
  });

  it('rechaza una tabla que no existe en ningún esquema', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(adapter.extract(connection, 'fantasma')).rejects.toThrow('La tabla no existe o no tiene columnas visibles');
  });
});

describe('buildPostgresSelect', () => {
  const COLUMNS = ['id', 'cliente_id', 'total', 'foto'];

  it('limita filas, calcula el tamaño de fila en el servidor y escapa identificadores', () => {
    const select = buildPostgresSelect('pedidos', 'ventas', COLUMNS, [], 100, 1_000_000);
    expect(select.text).toContain('FROM "ventas"."pedidos" AS "__dn_src"');
    expect(select.text).toMatch(/LIMIT 101$/);
    expect(select.text).toContain('octet_length("__dn_src"."foto"::text)');
    expect(select.text).toContain('> 1000000');
    expect(select.values).toEqual([]);
    expect(select.oversizedKey).toBe('__dn_oversized');
  });

  it('traduce los filtros a parámetros $n sin concatenar valores (filter pushdown)', () => {
    const malicious = "x'; DROP TABLE pedidos; --";
    const select = buildPostgresSelect(
      'pedidos',
      'public',
      COLUMNS,
      [
        { campo: 'cliente_id', operador: 'eq', valor: malicious },
        { campo: 'total', operador: 'gte', valor: 10 },
        { campo: 'id', operador: 'in', valor: [1, 2] },
        { campo: 'foto', operador: 'eq', valor: null },
      ],
      100,
      1_000_000,
    );
    expect(select.text).toContain(
      'WHERE "__dn_src"."cliente_id" = $1 AND "__dn_src"."total" >= $2 AND "__dn_src"."id" IN ($3, $4) AND "__dn_src"."foto" IS NULL',
    );
    expect(select.values).toEqual([malicious, 10, 1, 2]);
    expect(select.text).not.toContain('DROP TABLE');
  });

  it('escapa comillas dobles en nombres y rechaza campos de filtro que no existen', () => {
    expect(quotePostgresIdentifier('a"b', 'tabla')).toBe('"a""b"');
    expect(() =>
      buildPostgresSelect('pedidos', 'public', COLUMNS, [{ campo: 'id; --', operador: 'eq', valor: 1 }], 10, 100),
    ).toThrow(BadRequestException);
  });

  it('elige nombres de columnas auxiliares que no chocan con columnas reales', () => {
    const select = buildPostgresSelect('t', 'public', ['__dn_row_bytes', '__dn_oversized'], [], 10, 100);
    expect(select.oversizedKey).toBe('__dn_oversized_2');
    expect(select.text).toContain('"__dn_row_bytes_2"');
  });
});
