import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
const exportMocks = vi.hoisted(() => ({
  datasets: [] as Array<Record<string, any>[]>,
  wordOptions: [] as Array<{ title: string; masked?: boolean }>,
}));

import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
} from '@nestjs/common';
vi.mock('./export/export.service.js', () => ({
  WORD_CONTENT_TYPE: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ExportService: class {
    async exportToWord(rows: Record<string, any>[], options: { title: string; masked?: boolean }) {
      exportMocks.datasets.push(rows);
      exportMocks.wordOptions.push(options);
      return Buffer.from('word');
    }

    async exportToExcel(rows: Record<string, any>[]) {
      exportMocks.datasets.push(rows);
      return Buffer.from('excel');
    }

    async exportToPdf(rows: Record<string, any>[]) {
      exportMocks.datasets.push(rows);
      return Buffer.from('pdf');
    }

    exportToJson(rows: Record<string, any>[]) {
      exportMocks.datasets.push(rows);
      return Buffer.from('json');
    }
  },
}));

import { DataEngineService } from './data-engine.service.js';
import type { IDataSourceAdapter } from './adapters/data-source-adapter.interface.js';
import type { AdapterRegistry } from './adapters/adapter-registry.js';
import type { DataSourceClientPool } from './pool/data-source-client-pool.js';

/** Registro falso que devuelve el mismo adaptador para cualquier motor (o ninguno). */
function registryWith(adapter: Partial<IDataSourceAdapter> | undefined) {
  return {
    get: vi.fn(() =>
      adapter
        ? { tipoMotor: 'POSTGRESQL', capabilities: { explore: true, fields: true, extract: true }, ...adapter }
        : undefined,
    ),
  } as unknown as AdapterRegistry & { get: ReturnType<typeof vi.fn> };
}
import type { ConnectionsService } from '../connections/connections.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';

const actor: AuthenticatedUser = {
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

  it('returns only catalog metadata for an authorized connection', async () => {
    const adapter = {
      listObjects: vi.fn().mockResolvedValue([
        { name: 'customers', schema: 'public', type: 'TABLE' },
        { name: 'monthly_report', schema: 'public', type: 'VIEW' },
      ]),
    };
    const connection = {
      id: 'connection-1',
      tipoMotor: 'PostgreSQL',
      dbName: 'analytics',
      connectionString: 'postgres://user:secret@db.internal/analytics',
    };
    const getConnectionForExploration = vi.fn().mockResolvedValue(connection);
    const registry = registryWith(adapter);
    const service = new DataEngineService(
      { getConnectionForExploration } as unknown as ConnectionsService,
      registry,
    );

    const result = await service.exploreConnection(actor, 'connection-1');

    expect(getConnectionForExploration).toHaveBeenCalledWith('connection-1', 'workspace-1');
    expect(registry.get).toHaveBeenCalledWith('PostgreSQL');
    expect(adapter.listObjects).toHaveBeenCalledWith(connection);
    expect(result).toEqual({
      connectionId: 'connection-1',
      tipoMotor: 'PostgreSQL',
      objects: [
        { name: 'customers', schema: 'public', type: 'TABLE' },
        { name: 'monthly_report', schema: 'public', type: 'VIEW' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('returns an empty catalog when the external database has no objects', async () => {
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'MySQL',
          dbName: 'empty',
          connectionString: 'mysql://safe',
        }),
      } as unknown as ConnectionsService,
      registryWith({ listObjects: vi.fn().mockResolvedValue([]) }),
    );

    await expect(service.exploreConnection(actor, 'connection-1')).resolves.toMatchObject({ objects: [] });
  });

  it('does not look up an adapter if the connection is outside the actor workspace', async () => {
    const registry = registryWith({});
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockRejectedValue(new Error('connection not found')),
      } as unknown as ConnectionsService,
      registry,
    );

    await expect(service.exploreConnection(actor, 'foreign-connection')).rejects.toThrow('connection not found');
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('rejects an engine without adapter without returning any credentials', async () => {
    const registry = registryWith(undefined);
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'Oracle',
          dbName: 'db',
          connectionString: 'top-secret',
        }),
      } as unknown as ConnectionsService,
      registry,
    );

    await expect(service.exploreConnection(actor, 'connection-1')).rejects.toThrow(BadRequestException);
    expect(registry.get).toHaveBeenCalledWith('Oracle');
  });

  it('rejects field exploration when the adapter does not support it', async () => {
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'MONGODB',
          dbName: 'db',
          connectionString: 'mongodb://safe',
        }),
      } as unknown as ConnectionsService,
      registryWith({ capabilities: { explore: true, fields: false, extract: false } }),
    );

    await expect(service.exploreConnectionFields(actor, 'connection-1', 'orders')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('normalizes connection errors without leaking provider details', async () => {
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'SQLServer',
          dbName: 'db',
          connectionString: 'top-secret',
        }),
      } as unknown as ConnectionsService,
      registryWith({ listObjects: vi.fn().mockRejectedValue(new Error('login failed for top-secret')) }),
    );

    try {
      await service.exploreConnection(actor, 'connection-1');
      expect.fail('expected external failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BadGatewayException);
      expect((error as Error).message).not.toContain('top-secret');
    }
  });

  it('times out after ten seconds and discards the pooled clients of that connection', async () => {
    vi.useFakeTimers();
    const pool = { invalidate: vi.fn().mockResolvedValue(undefined) };
    const service = new DataEngineService(
      {
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'connection-1',
          tipoMotor: 'Firestore',
          dbName: '(default)',
          connectionString: '{}',
        }),
      } as unknown as ConnectionsService,
      registryWith({ listObjects: vi.fn().mockReturnValue(new Promise(() => undefined)) }),
      pool as unknown as DataSourceClientPool,
    );

    const request = service.exploreConnection(actor, 'connection-1');
    const rejection = expect(request).rejects.toThrow(GatewayTimeoutException);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(pool.invalidate).toHaveBeenCalledWith('connection-1');
  });

  it('reports UNSUPPORTED, HEALTHY and UNAVAILABLE in the health check', async () => {
    const adapters: Record<string, Partial<IDataSourceAdapter> | undefined> = {
      POSTGRESQL: { listObjects: vi.fn().mockResolvedValue([]) },
      MYSQL: { listObjects: vi.fn().mockRejectedValue(new Error('down')) },
      MONGODB: undefined,
    };
    const registry = {
      get: vi.fn((tipoMotor: string) => {
        const adapter = adapters[tipoMotor];
        return adapter ? { capabilities: { explore: true, fields: true, extract: true }, ...adapter } : undefined;
      }),
    } as unknown as AdapterRegistry;
    const service = new DataEngineService(
      {
        findAll: vi.fn().mockResolvedValue(
          ['POSTGRESQL', 'MYSQL', 'MONGODB'].map((tipoMotor) => ({ id: tipoMotor, tipoMotor, host: 'h', dbName: 'd' })),
        ),
        getConnectionForExploration: vi.fn((id: string) =>
          Promise.resolve({ id, tipoMotor: id, dbName: 'd', connectionString: 'x' }),
        ),
      } as unknown as ConnectionsService,
      registry,
    );

    const health = await service.getConnectionsHealth(actor as never);
    expect(health.connections.map((item) => [item.tipoMotor, item.status])).toEqual([
      ['POSTGRESQL', 'HEALTHY'],
      ['MYSQL', 'UNAVAILABLE'],
      ['MONGODB', 'UNSUPPORTED'],
    ]);
  });

  it('guarda el último health check de cada conexión para el dashboard (issue #40)', async () => {
    const recordHealthChecks = vi.fn().mockResolvedValue(undefined);
    const service = new DataEngineService(
      {
        findAll: vi.fn().mockResolvedValue([
          { id: 'ok', tipoMotor: 'POSTGRESQL', host: 'h', dbName: 'd' },
          { id: 'down', tipoMotor: 'MYSQL', host: 'h', dbName: 'd' },
        ]),
        getConnectionForExploration: vi.fn((id: string) =>
          Promise.resolve({ id, tipoMotor: id, dbName: 'd', connectionString: 'x' }),
        ),
        recordHealthChecks,
      } as unknown as ConnectionsService,
      {
        get: vi.fn((tipoMotor: string) => ({
          capabilities: { explore: true, fields: true, extract: true },
          listObjects: tipoMotor === 'MYSQL' ? vi.fn().mockRejectedValue(new Error('down')) : vi.fn().mockResolvedValue([]),
        })),
      } as unknown as AdapterRegistry,
    );

    await service.getConnectionsHealth(actor as never);

    expect(recordHealthChecks).toHaveBeenCalledWith('workspace-1', [
      { id: 'ok', status: 'HEALTHY', latencyMs: expect.any(Number) },
      { id: 'down', status: 'UNAVAILABLE', latencyMs: expect.any(Number) },
    ]);
  });

  it('el health check responde aunque no se pueda guardar el resultado', async () => {
    const service = new DataEngineService(
      {
        findAll: vi.fn().mockResolvedValue([{ id: 'ok', tipoMotor: 'POSTGRESQL', host: 'h', dbName: 'd' }]),
        getConnectionForExploration: vi.fn((id: string) =>
          Promise.resolve({ id, tipoMotor: id, dbName: 'd', connectionString: 'x' }),
        ),
        recordHealthChecks: vi.fn(() => {
          throw new Error('db caída');
        }),
      } as unknown as ConnectionsService,
      registryWith({ listObjects: vi.fn().mockResolvedValue([]) }),
    );

    await expect(service.getConnectionsHealth(actor as never)).resolves.toMatchObject({
      connections: [{ status: 'HEALTHY' }],
    });
  });

  describe('executeCrossJoin and executeCrossJoinForExport', () => {
    it('executes in-memory cross join, applies LECTOR masking and paginates result', async () => {
      const sqlConn = {
        id: 'conn-sql',
        tipoMotor: 'PostgreSQL',
        dbName: 'crm',
        connectionString: 'encrypted-sql',
      };
      const noSqlConn = {
        id: 'conn-nosql',
        tipoMotor: 'Firestore',
        dbName: 'store',
        connectionString: 'encrypted-firestore',
      };

      const connectionsService = {
        getConnectionForExploration: vi.fn().mockImplementation((id: string) => {
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
        registryWith(mockExtractor),
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
        getConnectionForExploration: vi.fn().mockImplementation((id: string) =>
          Promise.resolve({
            id,
            tipoMotor: id === 'conn-sql' ? 'SQLServer' : 'Firestore',
            dbName: 'analytics',
            connectionString: 'encrypted-secret',
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
        registryWith(extractor),
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
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'conn-1',
          tipoMotor: 'SQLServer',
          dbName: 'db',
          connectionString: 'encrypted-secret',
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
        registryWith(extractor),
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
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'conn-1',
          tipoMotor: 'SQLServer',
          dbName: 'db',
          connectionString: 'encrypted-secret',
        }),
      } as unknown as ConnectionsService;
      const extractor = {
        extract: vi
          .fn()
          .mockResolvedValue([{ key: 'same', payload: 'x'.repeat(100) }]),
      };
      const service = new DataEngineService(
        connectionsService,
        registryWith(extractor),
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
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'conn-1',
          tipoMotor: 'SQLServer',
          dbName: 'db',
          connectionString: 'encrypted-secret',
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
        registryWith(extractor),
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
        getConnectionForExploration: vi.fn().mockResolvedValue({
          id: 'conn-1',
          tipoMotor: 'PostgreSQL',
          dbName: 'crm',
          connectionString: 'encrypted-connection',
        }),
      } as unknown as ConnectionsService;

      const mockExtractor = {
        extract: vi
          .fn()
          .mockResolvedValue([{ id: '1', key: 'K1', value: 100 }]),
      };

      const service = new DataEngineService(
        connectionsService,
        registryWith(mockExtractor),
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

describe('DataEngineService aggregation pipeline', () => {
  const actorWithAccess: AuthenticatedUser = { ...actor, role: 'ADMIN' };
  const basePayload = {
    conexionSqlId: 'conn-sql',
    conexionNoSqlId: 'conn-nosql',
    tablaSql: 'clients',
    coleccionNoSql: 'orders',
    llaveSql: 'client_id',
    llaveNoSql: 'client_ref',
  };

  const createEngine = (
    sqlRows: Record<string, any>[],
    noSqlRows: Record<string, any>[],
  ) => {
    const connectionsService = {
      getConnectionForExploration: vi.fn().mockImplementation((id: string) =>
        Promise.resolve({
          id,
          tipoMotor: id === 'conn-sql' ? 'SQLServer' : 'Firestore',
          dbName: 'analytics',
          connectionString: 'encrypted-secret',
        }),
      ),
    } as unknown as ConnectionsService;
    const extractor = {
      extract: vi
        .fn()
        .mockImplementation((_connection, entityName) =>
          Promise.resolve(entityName === 'clients' ? sqlRows : noSqlRows),
        ),
    };
    return {
      service: new DataEngineService(
        connectionsService,
        registryWith(extractor),
      ),
      extractor,
    };
  };

  it('passes source filters and SQL schema to their respective adapters', async () => {
    const sqlFilter = { campo: 'active', operador: 'eq', valor: true };
    const noSqlFilter = { campo: 'amount', operador: 'gte', valor: 10 };
    const { service, extractor } = createEngine(
      [{ client_id: 'C1' }],
      [{ client_ref: 'C1' }],
    );

    await service.executeCrossJoin(
      {
        ...basePayload,
        esquemaSql: 'sales',
        filtrosSql: [sqlFilter],
        filtrosNoSql: [noSqlFilter],
      } as any,
      actorWithAccess,
    );

    expect(extractor.extract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'conn-sql' }),
      'clients',
      { schema: 'sales', filters: [sqlFilter] },
    );
    expect(extractor.extract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'conn-nosql' }),
      'orders',
      { filters: [noSqlFilter] },
    );
  });

  it('groups unified rows and calculates count, sum, and average', async () => {
    const { service } = createEngine(
      [
        { client_id: 'C1', status: 'sql-status' },
        { client_id: 'C2', status: 'sql-status' },
        { client_id: 'C3', status: 'sql-status' },
      ],
      [
        { client_ref: 'C1', status: 'paid', amount: 12 },
        { client_ref: 'C1', status: 'paid', amount: null },
        { client_ref: 'C2', status: 'paid', amount: 18 },
        { client_ref: 'C3', status: 'cancelled', amount: 30 },
      ],
    );

    const result = await service.executeCrossJoin(
      {
        ...basePayload,
        groupBy: ['sql.status', 'nosql.status'],
        aggregations: [
          { operation: 'COUNT', as: 'rows' },
          { operation: 'COUNT', field: 'amount', as: 'amounts' },
          { operation: 'SUM', field: 'amount', as: 'total' },
          { operation: 'AVG', field: 'amount', as: 'average' },
        ],
      } as any,
      actorWithAccess,
    );

    expect(result.total).toBe(2);
    expect(result.data).toEqual([
      {
        'sql.status': 'sql-status',
        'nosql.status': 'paid',
        rows: 3,
        amounts: 2,
        total: 30,
        average: 15,
      },
      {
        'sql.status': 'sql-status',
        'nosql.status': 'cancelled',
        rows: 1,
        amounts: 1,
        total: 30,
        average: 30,
      },
    ]);
  });

  it('calcula mínimo, máximo y valores distintos, ordena el resultado y renombra columnas (Query Builder)', async () => {
    const { service } = createEngine(
      [
        { client_id: 'C1', status: 'sql-status' },
        { client_id: 'C2', status: 'sql-status' },
        { client_id: 'C3', status: 'sql-status' },
      ],
      [
        { client_ref: 'C1', status: 'paid', amount: 12 },
        { client_ref: 'C1', status: 'paid', amount: 40 },
        { client_ref: 'C2', status: 'paid', amount: 18 },
        { client_ref: 'C3', status: 'cancelled', amount: 30 },
      ],
    );

    const result = await service.executeCrossJoin(
      {
        ...basePayload,
        groupBy: ['nosql.status'],
        aggregations: [
          { operation: 'MIN', field: 'amount', as: 'minimo' },
          { operation: 'MAX', field: 'amount', as: 'maximo' },
          { operation: 'COUNT_DISTINCT', field: 'client_ref', as: 'clientes' },
        ],
        ordenarPor: [{ campo: 'maximo', direccion: 'ASC' }],
        aliasColumnas: { 'nosql.status': 'Estado', clientes: 'Clientes distintos' },
      } as any,
      actorWithAccess,
    );

    expect(result.data).toEqual([
      { Estado: 'cancelled', minimo: 30, maximo: 30, 'Clientes distintos': 1 },
      { Estado: 'paid', minimo: 12, maximo: 40, 'Clientes distintos': 2 },
    ]);
  });

  it('returns an empty grouped result and a zero-row global aggregate', async () => {
    const { service } = createEngine([], []);
    const grouped = await service.executeCrossJoin(
      {
        ...basePayload,
        groupBy: ['status'],
        aggregations: [{ operation: 'COUNT', as: 'rows' }],
      } as any,
      actorWithAccess,
    );
    const global = await service.executeCrossJoin(
      {
        ...basePayload,
        aggregations: [
          { operation: 'COUNT', as: 'rows' },
          { operation: 'SUM', field: 'amount', as: 'total' },
          { operation: 'AVG', field: 'amount', as: 'average' },
        ],
      } as any,
      actorWithAccess,
    );

    expect(grouped.data).toEqual([]);
    expect(global.data).toEqual([{ rows: 0, total: null, average: null }]);
  });

  it('rejects non-numeric values for SUM and AVG', async () => {
    const { service } = createEngine(
      [{ client_id: 'C1' }],
      [{ client_ref: 'C1', amount: 'not-a-number' }],
    );

    await expect(
      service.executeCrossJoin(
        {
          ...basePayload,
          aggregations: [{ operation: 'SUM', field: 'amount', as: 'total' }],
        } as any,
        actorWithAccess,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('masks aggregate metrics derived from sensitive fields for LECTOR', async () => {
    const { service } = createEngine(
      [{ client_id: 'C1' }],
      [{ client_ref: 'C1', phone: 87654321 }],
    );

    const result = await service.executeCrossJoin(
      {
        ...basePayload,
        aggregations: [{ operation: 'SUM', field: 'phone', as: 'value' }],
      } as any,
      { ...actor, role: 'LECTOR' },
    );

    expect(result.data).toEqual([{ value: '********' }]);
  });

  it('keeps sensitive aggregate values masked in exports', async () => {
    exportMocks.datasets.length = 0;
    const { service } = createEngine(
      [{ client_id: 'C1' }],
      [{ client_ref: 'C1', phone: 87654321 }],
    );

    await service.executeCrossJoinForExport(
      {
        ...basePayload,
        aggregations: [{ operation: 'SUM', field: 'phone', as: 'value' }],
        format: 'json',
      } as any,
      { ...actor, role: 'LECTOR' },
    );

    expect(exportMocks.datasets.at(-1)).toEqual([{ value: '********' }]);
  });

  it('exporta a Word con los datos enmascarados según el rol (RF-21)', async () => {
    exportMocks.datasets.length = 0;
    exportMocks.wordOptions.length = 0;
    const { service } = createEngine(
      [{ client_id: 'C1' }],
      [{ client_ref: 'C1', phone: 87654321 }],
    );

    const lectorExport = await service.executeCrossJoinForExport(
      { ...basePayload, aggregations: [{ operation: 'SUM', field: 'phone', as: 'value' }], format: 'word' } as any,
      { ...actor, role: 'LECTOR' },
    );

    expect(lectorExport.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(lectorExport.filename).toMatch(/^datanexus_export_[0-9TZ-]+\.docx$/);
    expect(exportMocks.datasets.at(-1)).toEqual([{ value: '********' }]);
    expect(exportMocks.wordOptions.at(-1)).toMatchObject({ masked: true, title: expect.stringContaining('DataNexus') });

    await service.executeCrossJoinForExport(
      { ...basePayload, aggregations: [{ operation: 'SUM', field: 'phone', as: 'value' }], format: 'word' } as any,
      actorWithAccess,
    );

    expect(exportMocks.datasets.at(-1)).toEqual([{ value: 87654321 }]);
    expect(exportMocks.wordOptions.at(-1)).toMatchObject({ masked: false });
  });

  it('registra los bytes extraídos de las fuentes como datos procesados (issue #40)', async () => {
    const sqlRows = [{ client_id: 'C1', name: 'Ana' }];
    const noSqlRows = [{ client_ref: 'C1', total: 10 }];
    const { service: base } = createEngine(sqlRows, noSqlRows);
    const usageMeter = { recordBytesProcessed: vi.fn() };
    const service = new DataEngineService(
      (base as unknown as { connectionsService: ConnectionsService }).connectionsService,
      (base as unknown as { adapters: AdapterRegistry }).adapters,
      undefined,
      undefined,
      undefined,
      undefined,
      usageMeter as never,
    );

    await service.executeCrossJoin(basePayload as any, actorWithAccess);

    expect(usageMeter.recordBytesProcessed).toHaveBeenCalledWith(
      'workspace-1',
      Buffer.byteLength(JSON.stringify(sqlRows)) + Buffer.byteLength(JSON.stringify(noSqlRows)),
    );
  });

  it('preserves special metric aliases and ignores inherited source fields', async () => {
    const { service } = createEngine(
      [{ client_id: 'C1' }],
      [{ client_ref: 'C1' }],
    );

    const result = await service.executeCrossJoin(
      {
        ...basePayload,
        aggregations: [
          { operation: 'COUNT', field: 'toString', as: 'methodCount' },
          { operation: 'COUNT', field: 'phone', as: 'missingCount' },
          { operation: 'COUNT', as: '__proto__' },
        ],
      } as any,
      { ...actor, role: 'LECTOR' },
    );
    const row = result.data[0];

    expect(row.methodCount).toBe(0);
    expect(row.missingCount).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(row, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(row, '__proto__')?.value).toBe(1);
  });

  it('keeps 12,000 joined records within time and heap limits when grouped', async () => {
    const rowCount = 12_000;
    const sqlRows = Array.from({ length: rowCount }, (_, index) => ({
      client_id: `client-${index}`,
      bucket: `bucket-${Math.floor(index / 1_000)}`,
    }));
    const noSqlRows = Array.from({ length: rowCount }, (_, index) => ({
      client_ref: `client-${index}`,
      amount: 1,
    }));
    const { service } = createEngine(sqlRows, noSqlRows);
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();

    const result = await service.executeCrossJoin(
      {
        ...basePayload,
        groupBy: ['bucket'],
        aggregations: [
          { operation: 'COUNT', as: 'rows' },
          { operation: 'SUM', field: 'amount', as: 'total' },
          { operation: 'AVG', field: 'amount', as: 'average' },
        ],
      } as any,
      actorWithAccess,
    );

    const elapsedMs = performance.now() - startedAt;
    const heapGrowthBytes = Math.max(
      0,
      process.memoryUsage().heapUsed - heapBefore,
    );
    expect(result.total).toBe(12);
    expect(result.data.reduce((sum, row) => sum + row.rows, 0)).toBe(rowCount);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(heapGrowthBytes).toBeLessThan(64 * 1024 * 1024);
  });
});
