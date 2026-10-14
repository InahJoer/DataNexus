import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
} from '@nestjs/common';
vi.mock('./export/export.service.js', () => ({
  ExportService: class {
    async exportToExcel() {
      return Buffer.from('excel');
    }

    async exportToPdf() {
      return Buffer.from('pdf');
    }

    exportToJson() {
      return Buffer.from('json');
    }
  },
}));

import { DataEngineService } from './data-engine.service.js';
import type { DataExplorer } from './data-explorer.interface.js';
import type { ConnectionsService } from '../connections/connections.service.js';

const actor = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'User',
  role: 'LECTOR',
  workspaceId: 'workspace-1',
};

describe('DataEngineService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('returns only catalog metadata for an authorized connection and closes the explorer', async () => {
    const explorer: DataExplorer = {
      tipoMotor: 'PostgreSQL',
      listObjects: vi.fn().mockResolvedValue([
        { name: 'customers', schema: 'public', type: 'TABLE' },
        { name: 'monthly_report', schema: 'public', type: 'VIEW' },
      ]),
      close: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const getConnectionForExploration = vi.fn().mockResolvedValue({
      id: 'connection-1',
      tipoMotor: 'PostgreSQL',
      dbName: 'analytics',
      connectionString: 'postgres://user:secret@db.internal/analytics',
    });
    const createExplorer = vi.fn().mockReturnValue(explorer);
    const service = new DataEngineService(
      { getConnectionForExploration } as unknown as ConnectionsService,
      createExplorer,
    );

    const result = await service.exploreConnection(actor, 'connection-1');

    expect(getConnectionForExploration).toHaveBeenCalledWith(
      'connection-1',
      'workspace-1',
    );
    expect(explorer.listObjects).toHaveBeenCalledWith(
      'postgres://user:secret@db.internal/analytics',
      'analytics',
    );
    expect(result).toEqual({
      connectionId: 'connection-1',
      tipoMotor: 'PostgreSQL',
      objects: [
        { name: 'customers', schema: 'public', type: 'TABLE' },
        { name: 'monthly_report', schema: 'public', type: 'VIEW' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(explorer.close).toHaveBeenCalledOnce();
  });

  it('returns an empty catalog when the external database has no objects', async () => {
    const explorer: DataExplorer = {
      tipoMotor: 'MySQL',
      listObjects: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'MySQL',
          dbName: 'empty',
          connectionString: 'mysql://safe',
        }),
      } as unknown as ConnectionsService,
      () => explorer,
    );

    await expect(
      service.exploreConnection(actor, 'connection-1'),
    ).resolves.toMatchObject({
      objects: [],
    });
    expect(explorer.close).toHaveBeenCalledOnce();
  });

  it('does not create an explorer if the connection is outside the actor workspace', async () => {
    const createExplorer = vi.fn();
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi
          .fn()
          .mockRejectedValue(new Error('connection not found')),
      } as unknown as ConnectionsService,
      createExplorer,
    );

    await expect(
      service.exploreConnection(actor, 'foreign-connection'),
    ).rejects.toThrow('connection not found');
    expect(createExplorer).not.toHaveBeenCalled();
  });

  it('rejects an unsupported engine without returning any credentials', async () => {
    const createExplorer = vi.fn();
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'Oracle',
          dbName: 'db',
          connectionString: 'top-secret',
        }),
      } as unknown as ConnectionsService,
      createExplorer,
    );

    await expect(
      service.exploreConnection(actor, 'connection-1'),
    ).rejects.toThrow(BadRequestException);
    expect(createExplorer).toHaveBeenCalledWith('Oracle');
  });

  it('normalizes connection errors and closes the explorer', async () => {
    const explorer: DataExplorer = {
      tipoMotor: 'SQLServer',
      listObjects: vi
        .fn()
        .mockRejectedValue(new Error('login failed for top-secret')),
      close: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'SQLServer',
          dbName: 'db',
          connectionString: 'top-secret',
        }),
      } as unknown as ConnectionsService,
      () => explorer,
    );

    try {
      await service.exploreConnection(actor, 'connection-1');
      expect.fail('expected external failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BadGatewayException);
      expect((error as Error).message).not.toContain('top-secret');
    }
    expect(explorer.close).toHaveBeenCalledOnce();
  });

  it('times out after ten seconds and cancels the explorer', async () => {
    vi.useFakeTimers();
    const explorer: DataExplorer = {
      tipoMotor: 'Firestore',
      listObjects: vi.fn().mockReturnValue(new Promise(() => undefined)),
      close: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'Firestore',
          dbName: '(default)',
          connectionString: '{}',
        }),
      } as unknown as ConnectionsService,
      () => explorer,
    );

    const request = service.exploreConnection(actor, 'connection-1');
    const rejection = expect(request).rejects.toThrow(GatewayTimeoutException);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(explorer.cancel).toHaveBeenCalledOnce();
    expect(explorer.close).not.toHaveBeenCalled();
  });

  it('does not wait beyond the exploration deadline for a stuck close', async () => {
    vi.useFakeTimers();
    const explorer: DataExplorer = {
      tipoMotor: 'PostgreSQL',
      listObjects: vi
        .fn()
        .mockResolvedValue([{ name: 'customers', type: 'TABLE' }]),
      close: vi.fn().mockReturnValue(new Promise(() => undefined)),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'PostgreSQL',
          dbName: 'db',
          connectionString: 'postgres://safe',
        }),
      } as unknown as ConnectionsService,
      () => explorer,
    );

    const request = service.exploreConnection(actor, 'connection-1');
    const response = expect(request).resolves.toMatchObject({
      objects: [{ name: 'customers', type: 'TABLE' }],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await response;

    expect(explorer.close).toHaveBeenCalledOnce();
    expect(explorer.cancel).toHaveBeenCalledOnce();
  });

  describe('executeCrossJoin and executeCrossJoinForExport', () => {
    it('executes in-memory cross join, applies LECTOR masking and paginates result', async () => {
      const sqlConn = {
        id: 'conn-sql',
        tipoMotor: 'PostgreSQL',
        dbName: 'crm',
        encryptedConnectionString: 'encrypted-sql',
      };
      const noSqlConn = {
        id: 'conn-nosql',
        tipoMotor: 'Firestore',
        dbName: 'store',
        encryptedConnectionString: 'encrypted-firestore',
      };

      const connectionsService = {
        getConnectionForExtraction: vi
          .fn()
          .mockImplementation((id: string) => {
            if (id === 'conn-sql') return Promise.resolve(sqlConn);
            if (id === 'conn-nosql') return Promise.resolve(noSqlConn);
            return Promise.reject(new Error('Not found'));
          }),
      } as unknown as ConnectionsService;

      const mockExtractor = {
        extract: vi.fn().mockImplementation((conn, entity) => {
          if (entity === 'clientes') {
            return Promise.resolve([
              {
                id: '1',
                cliente_id: 'C1',
                nombre: 'Cliente 1',
                email: 'test@corp.com',
              },
              {
                id: '2',
                cliente_id: 'C2',
                nombre: 'Cliente 2',
                email: 'otro@corp.com',
              },
            ]);
          }
          if (entity === 'pedidos') {
            return Promise.resolve([
              {
                order_id: 'O1',
                cliente_ref: 'C1',
                total: 500,
                telefono: '+12345678',
              },
              { order_id: 'O2', cliente_ref: 'C99', total: 999 }, // No hace match
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const service = new DataEngineService(
        connectionsService,
        () => undefined,
        mockExtractor as any,
      );

      const result = await service.executeCrossJoin(
        {
          conexionSqlId: 'conn-sql',
          conexionNoSqlId: 'conn-nosql',
          tablaSql: 'clientes',
          coleccionNoSql: 'pedidos',
          llaveSql: 'cliente_id',
          llaveNoSql: 'cliente_ref',
          limit: 10,
          offset: 0,
        },
        actor, // role: 'LECTOR'
      );

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].cliente_id).toBe('C1');
      expect(result.data[0].order_id).toBe('O1');
      // Verificamos que se enmascaró para rol LECTOR
      expect(result.data[0].email).toBe('***@corp.com');
      expect(result.data[0].telefono).toBe('********');
    });

    it('preserves same-named fields from both sources and passes the SQL schema to its adapter', async () => {
      const connectionsService = {
        getConnectionForExtraction: vi.fn().mockImplementation((id: string) =>
          Promise.resolve({
            id,
            tipoMotor: id === 'conn-sql' ? 'SQLServer' : 'Firestore',
            dbName: 'analytics',
            encryptedConnectionString: 'encrypted-secret',
          }),
        ),
      } as unknown as ConnectionsService;
      const extractor = {
        extract: vi.fn().mockImplementation((_connection, entityName) =>
          Promise.resolve(
            entityName === 'customers'
              ? [{ id: 'sql-id', customer_id: 'C1', name: 'SQL customer' }]
              : [
                  {
                    id: 'firestore-id',
                    customer_id: 'C1',
                    name: 'Firestore document',
                  },
                ],
          ),
        ),
      };
      const service = new DataEngineService(
        connectionsService,
        () => undefined,
        extractor as any,
      );

      const result = await service.executeCrossJoin(
        {
          conexionSqlId: 'conn-sql',
          conexionNoSqlId: 'conn-firestore',
          tablaSql: 'customers',
          esquemaSql: 'sales',
          coleccionNoSql: 'orders',
          llaveSql: 'customer_id',
          llaveNoSql: 'customer_id',
        },
        { ...actor, role: 'ADMIN' },
      );

      expect(extractor.extract).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 'conn-sql' }),
        'customers',
        { schema: 'sales' },
      );
      expect(result.data[0]).toEqual({
        'sql.id': 'sql-id',
        'sql.customer_id': 'C1',
        'sql.name': 'SQL customer',
        'nosql.id': 'firestore-id',
        'nosql.customer_id': 'C1',
        'nosql.name': 'Firestore document',
      });
    });

    it('rejects a join whose many-to-many matches exceed the output cap', async () => {
      vi.stubEnv('DATA_ENGINE_MAX_JOIN_ROWS', '1');
      const connectionsService = {
        getConnectionForExtraction: vi.fn().mockResolvedValue({
          id: 'conn-1',
          tipoMotor: 'SQLServer',
          dbName: 'db',
          encryptedConnectionString: 'encrypted-secret',
        }),
      } as unknown as ConnectionsService;
      const extractor = {
        extract: vi
          .fn()
          .mockImplementation((_connection, entityName) =>
            Promise.resolve(
              entityName === 'source'
                ? [{ key: 'same' }]
                : [{ key: 'same' }, { key: 'same' }],
            ),
          ),
      };
      const service = new DataEngineService(
        connectionsService,
        () => undefined,
        extractor as any,
      );

      await expect(
        service.executeCrossJoin(
          {
            conexionSqlId: 'conn-1',
            conexionNoSqlId: 'conn-1',
            tablaSql: 'source',
            coleccionNoSql: 'documents',
            llaveSql: 'key',
            llaveNoSql: 'key',
          },
          actor,
        ),
      ).rejects.toMatchObject({ status: 413 });
    });

    it('rejects joins that exceed the configured output byte cap', async () => {
      vi.stubEnv('DATA_ENGINE_MAX_JOIN_BYTES', '20');
      const connectionsService = {
        getConnectionForExtraction: vi.fn().mockResolvedValue({
          id: 'conn-1',
          tipoMotor: 'SQLServer',
          dbName: 'db',
          encryptedConnectionString: 'encrypted-secret',
        }),
      } as unknown as ConnectionsService;
      const extractor = {
        extract: vi
          .fn()
          .mockResolvedValue([{ key: 'same', payload: 'x'.repeat(100) }]),
      };
      const service = new DataEngineService(
        connectionsService,
        () => undefined,
        extractor as any,
      );

      await expect(
        service.executeCrossJoin(
          {
            conexionSqlId: 'conn-1',
            conexionNoSqlId: 'conn-1',
            tablaSql: 'source',
            coleccionNoSql: 'documents',
            llaveSql: 'key',
            llaveNoSql: 'key',
          },
          actor,
        ),
      ).rejects.toMatchObject({ status: 413 });
    });

    it('keeps the indexed in-memory join responsive for ten thousand rows per source', async () => {
      const rowCount = 10_000;
      const connectionsService = {
        getConnectionForExtraction: vi.fn().mockResolvedValue({
          id: 'conn-1',
          tipoMotor: 'SQLServer',
          dbName: 'db',
          encryptedConnectionString: 'encrypted-secret',
        }),
      } as unknown as ConnectionsService;
      const sqlRows = Array.from({ length: rowCount }, (_, index) => ({
        customer_id: `customer-${index}`,
        source: 'sql',
      }));
      const documents = Array.from({ length: rowCount }, (_, index) => ({
        customer_id: `customer-${index}`,
        order_id: `order-${index}`,
      }));
      const extractor = {
        extract: vi
          .fn()
          .mockImplementation((_connection, entityName) =>
            Promise.resolve(entityName === 'customers' ? sqlRows : documents),
          ),
      };
      const service = new DataEngineService(
        connectionsService,
        () => undefined,
        extractor as any,
      );

      const startedAt = performance.now();
      const result = await service.executeCrossJoin(
        {
          conexionSqlId: 'conn-1',
          conexionNoSqlId: 'conn-1',
          tablaSql: 'customers',
          coleccionNoSql: 'orders',
          llaveSql: 'customer_id',
          llaveNoSql: 'customer_id',
        },
        { ...actor, role: 'ADMIN' },
      );
      const elapsedMs = performance.now() - startedAt;

      expect(result.total).toBe(rowCount);
      expect(result.data).toHaveLength(50);
      expect(elapsedMs).toBeLessThan(2_000);
    });

    it('exports cross-join data to Excel and PDF formats', async () => {
      const connectionsService = {
        getConnectionForExtraction: vi.fn().mockResolvedValue({
          id: 'conn-1',
          tipoMotor: 'PostgreSQL',
          dbName: 'crm',
          encryptedConnectionString: 'encrypted-connection',
        }),
      } as unknown as ConnectionsService;

      const mockExtractor = {
        extract: vi
          .fn()
          .mockResolvedValue([{ id: '1', key: 'K1', value: 100 }]),
      };

      const service = new DataEngineService(
        connectionsService,
        () => undefined,
        mockExtractor as any,
      );

      const excelExport = await service.executeCrossJoinForExport(
        {
          conexionSqlId: 'conn-1',
          conexionNoSqlId: 'conn-1',
          tablaSql: 't1',
          coleccionNoSql: 't2',
          llaveSql: 'key',
          llaveNoSql: 'key',
          format: 'excel',
        },
        actor,
      );

      expect(excelExport.contentType).toContain('spreadsheetml');
      expect(Buffer.isBuffer(excelExport.buffer)).toBe(true);

      const pdfExport = await service.executeCrossJoinForExport(
        {
          conexionSqlId: 'conn-1',
          conexionNoSqlId: 'conn-1',
          tablaSql: 't1',
          coleccionNoSql: 't2',
          llaveSql: 'key',
          llaveNoSql: 'key',
          format: 'pdf',
        },
        actor,
      );

      expect(pdfExport.contentType).toBe('application/pdf');
      expect(Buffer.isBuffer(pdfExport.buffer)).toBe(true);
    });
  });
});
