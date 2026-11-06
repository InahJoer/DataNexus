import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

const mocks = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  query: vi.fn(),
  close: vi.fn(),
  cancel: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
  columns: ['id', 'name'],
  queries: [] as string[],
  parameters: {} as Record<string, unknown>,
  handlers: {} as Record<string, (value?: any) => void>,
  parseConnectionString: vi.fn(),
}));

vi.mock('mssql', () => {
  const ConnectionPool = Object.assign(
    vi.fn(function (config: Record<string, unknown>) {
      mocks.configs.push(config);
      return {
        on: vi.fn(),
        connect: mocks.connect,
        request: () => {
          const request = {
            stream: false,
            on: (event: string, handler: (value?: any) => void) => {
              mocks.handlers[event] = handler;
            },
            cancel: mocks.cancel,
            query: mocks.query,
            input: (name: string, ...rest: unknown[]) => {
              mocks.parameters[name] = rest.length > 1 ? rest[1] : rest[0];
              return request;
            },
          };
          return request;
        },
        close: mocks.close,
      };
    }),
    { parseConnectionString: mocks.parseConnectionString },
  );
  return { default: { ConnectionPool, NVarChar: (length: number) => `NVarChar(${length})` } };
});

import { SqlServerAdapter } from './sqlserver.adapter.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';

const connection = {
  id: 'sql-1',
  tipoMotor: 'SQLSERVER',
  dbName: 'analytics',
  connectionString: 'Server=db.internal;Database=old;User Id=reader;Password=secret;',
};

describe('SqlServerAdapter', () => {
  let pool: DataSourceClientPool;
  let adapter: SqlServerAdapter;

  beforeEach(() => {
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_ROWS', '2');
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_BYTES', '1000');
    mocks.configs.length = 0;
    mocks.connect.mockReset().mockResolvedValue(undefined);
    mocks.rows = [{ id: 7, name: 'Ana' }];
    mocks.columns = ['id', 'name'];
    mocks.queries = [];
    mocks.parameters = {};
    mocks.handlers = {};
    mocks.query.mockReset().mockImplementation((query: string) => {
      mocks.queries.push(query);
      if (query.includes('[sys].[columns]')) {
        return Promise.resolve({ recordset: mocks.columns.map((name) => ({ name })) });
      }
      if (query.includes('INFORMATION_SCHEMA')) {
        return Promise.resolve({ recordset: [{ schema: 'dbo', name: 'Clients', type: 'BASE TABLE' }] });
      }
      queueMicrotask(() => {
        for (const row of mocks.rows) mocks.handlers.row?.({ ...row });
        mocks.handlers.done?.({});
      });
      return Promise.resolve();
    });
    mocks.close.mockReset().mockResolvedValue(undefined);
    mocks.cancel.mockReset();
    mocks.parseConnectionString.mockReset().mockReturnValue({ pool: { max: 5 } });
    pool = new DataSourceClientPool();
    adapter = new SqlServerAdapter(pool);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool.onModuleDestroy();
  });

  const select = () => mocks.queries.find((query) => query.includes('SELECT TOP'));

  it('lee la tabla con identificadores escapados y la base del registro', async () => {
    const rows = await adapter.extract(connection, 'Clients] ; DROP TABLE Users --', { schema: 'sales' });

    expect(rows).toEqual([{ id: 7, name: 'Ana' }]);
    expect(mocks.parseConnectionString).toHaveBeenCalledWith(connection.connectionString);
    expect(mocks.configs[0]).toMatchObject({
      database: 'analytics',
      connectionTimeout: 8_000,
      requestTimeout: 8_000,
      pool: { max: 4, min: 0 },
    });
    expect(mocks.queries[0]).toContain("OBJECT_ID(N'[sales].[Clients]] ; DROP TABLE Users --]')");
    expect(select()).toContain('SELECT TOP (3)');
    expect(select()).toContain('CASE WHEN ([__dataNexusMetrics].[row_bytes] * 8) + ');
    expect(select()).toContain('THEN NULL ELSE [__dataNexusSource].[id] END AS [id]');
    expect(select()).toContain('DATALENGTH([__dataNexusSource].[name])');
  });

  it('reutiliza el pool entre exploración y extracción y lo cierra solo al invalidar', async () => {
    await adapter.listObjects(connection);
    await adapter.listFields(connection, 'Clients', 'dbo');
    await adapter.extract(connection, 'Clients');
    expect(mocks.configs).toHaveLength(1);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.parameters).toMatchObject({ tableName: 'Clients', schemaName: 'dbo' });

    await pool.invalidate('sql-1');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('rechaza identificadores inválidos antes de conectar', async () => {
    await expect(adapter.extract(connection, '')).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.configs).toHaveLength(0);
  });

  it('se detiene si la tabla no tiene columnas visibles', async () => {
    mocks.columns = [];
    await expect(adapter.extract(connection, 'MissingTable')).rejects.toBeInstanceOf(BadRequestException);
    expect(select()).toBeUndefined();
  });

  it('propaga los errores de la consulta', async () => {
    const sourceError = new Error('source query failed');
    mocks.query.mockImplementation((query: string) => {
      mocks.queries.push(query);
      if (query.includes('[sys].[columns]')) {
        return Promise.resolve({ recordset: mocks.columns.map((name) => ({ name })) });
      }
      return Promise.reject(sourceError);
    });
    await expect(adapter.extract(connection, 'Clients')).rejects.toBe(sourceError);
  });

  it('traduce los filtros a parámetros y expande IN', async () => {
    const unsafeValue = "active' OR 1=1 --";
    mocks.columns = ['id', 'status'];
    mocks.rows = [{ id: 7, status: 'active' }];

    const rows = await adapter.extract(connection, 'Clients', {
      filters: [
        { campo: 'status', operador: 'eq', valor: unsafeValue },
        { campo: 'id', operador: 'in', valor: [2, 7] },
      ],
    } as never);

    expect(rows).toEqual([{ id: 7, status: 'active' }]);
    expect(select()).toContain('[__dataNexusSource].[status] = @filter_0');
    expect(select()).toContain('[__dataNexusSource].[id] IN (@filter_1, @filter_2)');
    expect(select()).not.toContain(unsafeValue);
    expect(mocks.parameters).toEqual({ filter_0: unsafeValue, filter_1: 2, filter_2: 7 });
  });

  it('traduce null a IS NULL / IS NOT NULL y rechaza campos u operadores desconocidos', async () => {
    mocks.columns = ['status'];
    await adapter.extract(connection, 'Clients', {
      filters: [
        { campo: 'status', operador: 'eq', valor: null },
        { campo: 'status', operador: 'neq', valor: null },
      ],
    } as never);
    expect(select()).toContain('[__dataNexusSource].[status] IS NULL');
    expect(select()).toContain('[__dataNexusSource].[status] IS NOT NULL');
    await expect(
      adapter.extract(connection, 'Clients', { filters: [{ campo: 'missing', operador: 'eq', valor: 'x' }] } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      adapter.extract(connection, 'Clients', { filters: [{ campo: 'status', operador: 'raw', valor: 'x' }] } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['neq', '<>', 4],
    ['gt', '>', 4],
    ['gte', '>=', 4],
    ['lt', '<', 4],
    ['lte', '<=', 4],
    ['not-in', 'NOT IN (@filter_0, @filter_1)', [4, 5]],
  ])('envía el operador %s a la consulta', async (operator, expected, value) => {
    mocks.columns = ['age'];
    await adapter.extract(connection, 'Clients', { filters: [{ campo: 'age', operador: operator, valor: value }] } as never);
    expect(select()).toContain(`[__dataNexusSource].[age] ${expected}`);
  });

  it.each([
    ['null con un operador de orden', { campo: 'age', operador: 'gt', valor: null }],
    ['null dentro de IN', { campo: 'age', operador: 'in', valor: [null] }],
    ['un objeto', { campo: 'age', operador: 'eq', valor: { value: 4 } }],
    ['IN vacío', { campo: 'age', operador: 'in', valor: [] }],
    ['IN de más de 10', { campo: 'age', operador: 'in', valor: Array.from({ length: 11 }, (_, i) => i) }],
  ])('rechaza %s sin ejecutar la consulta', async (_label, filter) => {
    mocks.columns = ['age'];
    await expect(adapter.extract(connection, 'Clients', { filters: [filter] } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(select()).toBeUndefined();
  });

  it('corta al superar el máximo de filas y cancela la consulta', async () => {
    mocks.rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await expect(adapter.extract(connection, 'Clients')).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it('corta cuando el servidor marca una fila como demasiado grande', async () => {
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_BYTES', '20');
    mocks.columns = ['value'];
    mocks.rows = [{ value: null, __dataNexusOversized: true }];
    await expect(adapter.extract(connection, 'Clients')).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(select()).toContain('THEN NULL ELSE [__dataNexusSource].[value] END AS [value]');
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it('un fallo al conectar no queda en caché', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('ELOGIN'));
    await expect(adapter.listObjects(connection)).rejects.toThrow('ELOGIN');
    await expect(adapter.listObjects(connection)).resolves.toEqual([
      { name: 'Clients', schema: 'dbo', type: 'TABLE' },
    ]);
    expect(mocks.configs).toHaveLength(2);
  });
});
