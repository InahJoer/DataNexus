import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { EncryptionService } from '../../common/encryption/encryption.service.js';

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
            input: (name: string, value: unknown) => {
              mocks.parameters[name] = value;
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

  return { default: { ConnectionPool } };
});

import { SqlServerDataExtractor } from './sqlserver-data-extractor.js';

const connection = {
  id: 'sql-1',
  tipoMotor: 'SQLServer',
  dbName: 'analytics',
  encryptedConnectionString: 'encrypted-connection-string',
};
const encryptionService = {
  decrypt: vi
    .fn()
    .mockReturnValue(
      'Server=db.internal;Database=old;User Id=reader;Password=secret;',
    ),
} as unknown as EncryptionService;

describe('SqlServerDataExtractor', () => {
  beforeEach(() => {
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
        return Promise.resolve({
          recordset: mocks.columns.map((name) => ({ name })),
        });
      }
      queueMicrotask(() => {
        for (const row of mocks.rows) mocks.handlers.row?.(row);
        mocks.handlers.done?.({});
      });
      return Promise.resolve();
    });
    mocks.close.mockReset().mockResolvedValue(undefined);
    mocks.cancel.mockReset();
    mocks.parseConnectionString
      .mockReset()
      .mockReturnValue({ pool: { max: 5 } });
    vi.mocked(encryptionService.decrypt)
      .mockReset()
      .mockReturnValue(
        'Server=db.internal;Database=old;User Id=reader;Password=secret;',
      );
  });

  it('reads rows from the selected table with escaped identifiers and the stored database', async () => {
    const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);

    const rows = await extractor.extract(
      connection,
      'Clients] ; DROP TABLE Users --',
      {
        schema: 'sales',
      },
    );

    expect(rows).toEqual([{ id: 7, name: 'Ana' }]);
    expect(encryptionService.decrypt).toHaveBeenCalledWith(
      'encrypted-connection-string',
    );
    expect(mocks.parseConnectionString).toHaveBeenCalledWith(
      'Server=db.internal;Database=old;User Id=reader;Password=secret;',
    );
    expect(mocks.configs[0]).toMatchObject({
      database: 'analytics',
      connectionTimeout: 8_000,
      requestTimeout: 8_000,
      pool: { max: 1, min: 0 },
    });
    expect(mocks.queries[0]).toContain(
      "OBJECT_ID(N'[sales].[Clients]] ; DROP TABLE Users --]')",
    );
    expect(mocks.queries[1]).toContain('SELECT TOP (3)');
    expect(mocks.queries[1]).toContain(
      'CASE WHEN ([__dataNexusMetrics].[row_bytes] * 8) + ',
    );
    expect(mocks.queries[1]).toContain(
      'THEN NULL ELSE [__dataNexusSource].[id] END AS [id]',
    );
    expect(mocks.queries[1]).toContain(
      'DATALENGTH([__dataNexusSource].[name])',
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('rejects invalid table identifiers before opening a connection', async () => {
    const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);

    await expect(extractor.extract(connection, '')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(mocks.configs).toHaveLength(0);
  });

  it('stops when the table has no visible columns', async () => {
    const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);
    mocks.columns = [];

    await expect(
      extractor.extract(connection, 'MissingTable'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mocks.queries.some((query) => query.includes('SELECT TOP'))).toBe(
      false,
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('propagates source query errors and closes the connection pool', async () => {
    const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);
    const sourceError = new Error('source query failed');
    mocks.query.mockImplementation((query: string) => {
      mocks.queries.push(query);
      if (query.includes('[sys].[columns]')) {
        return Promise.resolve({
          recordset: mocks.columns.map((name) => ({ name })),
        });
      }
      return Promise.reject(sourceError);
    });

    await expect(extractor.extract(connection, 'Clients')).rejects.toBe(
      sourceError,
    );

    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('pushes down filters with bound parameters and expands IN values', async () => {
    const unsafeValue = "active' OR 1=1 --";
    const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);
    mocks.columns = ['id', 'status'];
    mocks.rows = [{ id: 7, status: 'active' }];

    const rows = await extractor.extract(connection, 'Clients', {
      filters: [
        { campo: 'status', operador: 'eq', valor: unsafeValue },
        { campo: 'id', operador: 'in', valor: [2, 7] },
      ],
    } as any);

    const select = mocks.queries.find((query) => query.includes('SELECT TOP'));
    expect(rows).toEqual([{ id: 7, status: 'active' }]);
    expect(select).toContain('[__dataNexusSource].[status] = @filter_0');
    expect(select).toContain(
      '[__dataNexusSource].[id] IN (@filter_1_0, @filter_1_1)',
    );
    expect(select).not.toContain(unsafeValue);
    expect(mocks.parameters).toEqual({
      filter_0: unsafeValue,
      filter_1_0: 2,
      filter_1_1: 7,
    });
  });

  it('translates null equality and inequality and rejects unknown fields or operators', async () => {
    const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);
    mocks.columns = ['status'];

    await extractor.extract(connection, 'Clients', {
      filters: [
        { campo: 'status', operador: 'eq', valor: null },
        { campo: 'status', operador: 'neq', valor: null },
      ],
    } as any);

    const select = mocks.queries.find((query) => query.includes('SELECT TOP'));
    expect(select).toContain('[__dataNexusSource].[status] IS NULL');
    expect(select).toContain('[__dataNexusSource].[status] IS NOT NULL');
    await expect(
      extractor.extract(connection, 'Clients', {
        filters: [{ campo: 'missing', operador: 'eq', valor: 'x' }],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      extractor.extract(connection, 'Clients', {
        filters: [{ campo: 'status', operador: 'raw', valor: 'x' }],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['neq', '<>', 4],
    ['gt', '>', 4],
    ['gte', '>=', 4],
    ['lt', '<', 4],
    ['lte', '<=', 4],
    ['not-in', 'NOT IN (@filter_0_0, @filter_0_1)', [4, 5]],
  ])(
    'pushes SQL operator %s into the source query',
    async (operator, expected, value) => {
      const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);
      mocks.columns = ['age'];

      await extractor.extract(connection, 'Clients', {
        filters: [{ campo: 'age', operador: operator, valor: value }],
      } as any);

      const select = mocks.queries.find((query) =>
        query.includes('SELECT TOP'),
      );
      expect(select).toContain(`[__dataNexusSource].[age] ${expected}`);
    },
  );

  it('rejects null ordered comparisons and invalid list values', async () => {
    const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);
    mocks.columns = ['age'];

    await expect(
      extractor.extract(connection, 'Clients', {
        filters: [{ campo: 'age', operador: 'gt', valor: null }],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      extractor.extract(connection, 'Clients', {
        filters: [{ campo: 'age', operador: 'in', valor: [null] }],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-scalar values before binding a SQL parameter', async () => {
    const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);
    mocks.columns = ['age'];

    await expect(
      extractor.extract(connection, 'Clients', {
        filters: [{ campo: 'age', operador: 'eq', valor: { value: 4 } }],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mocks.queries.some((query) => query.includes('SELECT TOP'))).toBe(
      false,
    );
  });

  it.each([[], Array.from({ length: 11 }, (_, index) => index)])(
    'rejects invalid IN filter sizes before executing the source query',
    async (values) => {
      const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);
      mocks.columns = ['id'];

      await expect(
        extractor.extract(connection, 'Clients', {
          filters: [{ campo: 'id', operador: 'in', valor: values }],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.queries.some((query) => query.includes('SELECT TOP'))).toBe(
        false,
      );
    },
  );

  it('stops after the configured row cap and closes the pool', async () => {
    mocks.rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const extractor = new SqlServerDataExtractor(encryptionService, 2, 1_000);

    await expect(
      extractor.extract(connection, 'Clients'),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it('stops streaming when the source byte cap is exceeded', async () => {
    mocks.columns = ['value'];
    mocks.rows = [{ value: null, __dataNexusOversized: true }];
    const extractor = new SqlServerDataExtractor(encryptionService, 5, 20);

    await expect(
      extractor.extract(connection, 'Clients'),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(mocks.queries[1]).toContain(
      'CASE WHEN ([__dataNexusMetrics].[row_bytes] * 8) + ',
    );
    expect(mocks.queries[1]).toContain(
      'THEN NULL ELSE [__dataNexusSource].[value] END AS [value]',
    );
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
