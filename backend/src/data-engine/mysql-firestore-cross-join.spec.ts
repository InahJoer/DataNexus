import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Criterio de aceptación del #28: un cross-join MySQL × Firestore de punta a punta, con DataEngineService,
 * AdapterRegistry, los adaptadores reales y el pool. Solo se simulan los drivers (mysql2 y Firestore).
 */
const mocks = vi.hoisted(() => ({
  mysqlRows: [
    { id: 1, cliente_id: 'C1', nombre: 'Ana', email: 'ana@corp.com', __dn_oversized: 0 },
    { id: 2, cliente_id: 'C2', nombre: 'Luis', email: 'luis@corp.com', __dn_oversized: 0 },
  ],
  mysqlSql: [] as Array<{ sql: string; params: unknown[] }>,
  firestoreFilters: [] as Array<[string, string, unknown]>,
  firestoreDocs: [
    { id: 'p1', data: { cliente_ref: 'C1', total: 120, estado: 'pagado' } },
    { id: 'p2', data: { cliente_ref: 'C9', total: 50, estado: 'pagado' } },
  ],
  poolsCreated: 0,
  firestoreClients: 0,
}));

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: vi.fn(() => {
      mocks.poolsCreated += 1;
      return {
        on: vi.fn(),
        end: vi.fn(async () => undefined),
        query: vi.fn(async () => [
          ['id', 'cliente_id', 'nombre', 'email'].map((COLUMN_NAME) => ({ COLUMN_NAME })),
          [],
        ]),
        getConnection: vi.fn(async () => ({
          release: vi.fn(),
          destroy: vi.fn(),
          connection: {
            query: (sql: string, params: unknown[]) => {
              mocks.mysqlSql.push({ sql, params });
              return { stream: () => Readable.from(mocks.mysqlRows.map((row) => ({ ...row })), { objectMode: true }) };
            },
          },
        })),
      };
    }),
  },
}));

vi.mock('@google-cloud/firestore', () => ({
  Firestore: vi.fn(function () {
    mocks.firestoreClients += 1;
    const query: Record<string, any> = {
      where: (field: string, op: string, value: unknown) => {
        mocks.firestoreFilters.push([field, op, value]);
        return query;
      },
      limit: () => query,
      stream: () =>
        Readable.from(
          mocks.firestoreDocs.map((doc) => ({ id: doc.id, data: () => doc.data })),
          { objectMode: true },
        ),
    };
    return { collection: () => query, terminate: vi.fn(async () => undefined) };
  }),
}));

import { DataEngineService } from './data-engine.service.js';
import { AdapterRegistry } from './adapters/adapter-registry.js';
import { MysqlAdapter } from './adapters/mysql.adapter.js';
import { FirestoreAdapter } from './adapters/firestore.adapter.js';
import { PostgresAdapter } from './adapters/postgres.adapter.js';
import { SqlServerAdapter } from './adapters/sqlserver.adapter.js';
import { DataSourceClientPool } from './pool/data-source-client-pool.js';
import type { ConnectionsService } from '../connections/connections.service.js';

const connections = {
  mysql: { id: 'mysql-1', tipoMotor: 'MYSQL', dbName: 'crm', connectionString: 'mysql://u:p@db.internal:3306/crm' },
  firestore: {
    id: 'fs-1',
    tipoMotor: 'FIRESTORE',
    dbName: '(default)',
    connectionString: JSON.stringify({ project_id: 'p-1', client_email: 'r@p-1.iam.gserviceaccount.com', private_key: 'k' }),
  },
};

describe('Cross-join MySQL × Firestore (issue #28)', () => {
  let pool: DataSourceClientPool;
  afterEach(async () => {
    await pool.onModuleDestroy();
  });

  it('cruza clientes de MySQL con pedidos de Firestore aplicando filtros en cada fuente', async () => {
    pool = new DataSourceClientPool();
    const registry = new AdapterRegistry([
      new PostgresAdapter(pool),
      new MysqlAdapter(pool),
      new SqlServerAdapter(pool),
      new FirestoreAdapter(pool),
    ]);
    const connectionsService = {
      getConnectionForExploration: vi.fn(async (id: string) =>
        id === 'mysql-1' ? connections.mysql : connections.firestore,
      ),
    } as unknown as ConnectionsService;
    const engine = new DataEngineService(connectionsService, registry, pool);

    const request = {
      conexionSqlId: 'mysql-1',
      conexionNoSqlId: 'fs-1',
      tablaSql: 'clientes',
      coleccionNoSql: 'pedidos',
      llaveSql: 'cliente_id',
      llaveNoSql: 'cliente_ref',
      filtrosSql: [{ campo: 'nombre', operador: 'neq', valor: "x' OR 1=1 --" }],
      filtrosNoSql: [{ campo: 'estado', operador: 'eq', valor: 'pagado' }],
    } as never;
    const result = await engine.executeCrossJoin(request, {
      id: 'u',
      email: 'u@corp.com',
      name: 'U',
      role: 'OPERADOR',
      workspaceId: 'ws-1',
    });

    expect(result.total).toBe(1);
    expect(result.data[0]).toEqual({
      id: 1,
      cliente_id: 'C1',
      nombre: 'Ana',
      email: 'ana@corp.com',
      cliente_ref: 'C1',
      total: 120,
      estado: 'pagado',
      __documentId: 'p1',
    });
    expect(mocks.mysqlSql[0].sql).toContain('WHERE `__dn_src`.`nombre` <> ?');
    expect(mocks.mysqlSql[0].params).toEqual(["x' OR 1=1 --"]);
    expect(mocks.firestoreFilters).toEqual([['estado', '==', 'pagado']]);

    // Un segundo join reutiliza los clientes del pool en lugar de abrir conexiones nuevas.
    await engine.executeCrossJoin(request, { id: 'u', email: 'u@corp.com', name: 'U', role: 'OPERADOR', workspaceId: 'ws-1' });
    expect(mocks.poolsCreated).toBe(1);
    expect(mocks.firestoreClients).toBe(1);
    expect(pool.stats().size).toBe(2);
  });
});
