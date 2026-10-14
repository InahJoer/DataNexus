import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PayloadTooLargeException } from '@nestjs/common';
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
        request: () => ({
          stream: false,
          on: (event: string, handler: (value?: any) => void) => {
            mocks.handlers[event] = handler;
          },
          cancel: mocks.cancel,
          query: mocks.query,
        }),
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
  decrypt: vi.fn().mockReturnValue(
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
    vi.mocked(encryptionService.decrypt).mockReset().mockReturnValue(
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
