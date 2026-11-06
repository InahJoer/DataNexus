import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { DataEngineService } from './data-engine.service.js';
import { AdapterRegistry } from './adapters/adapter-registry.js';
import { PostgresAdapter } from './adapters/postgres.adapter.js';
import { MongoDbAdapter } from './adapters/mongodb.adapter.js';
import { DataSourceClientPool } from './pool/data-source-client-pool.js';
import type { ConnectionsService } from '../connections/connections.service.js';

/**
 * Criterio de aceptación del #29: cross-join PostgreSQL × MongoDB de punta a punta con DataEngineService, el
 * registro de adaptadores y el pool, contra un PostgreSQL real (DATABASE_URL, en CI) y un mongod en memoria.
 */
describe.skipIf(!process.env.DATABASE_URL)('Cross-join PostgreSQL × MongoDB (issue #29)', () => {
  const table = `dn_it_clientes_${Date.now()}`;
  const pgUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/x');
  pgUrl.search = '';
  const admin = new Client({ connectionString: pgUrl.toString() });
  const lunaId = new ObjectId();
  let mongo: MongoMemoryServer;
  let seed: MongoClient;
  let pool: DataSourceClientPool;
  let engine: DataEngineService;

  const actor = (role: string) => ({ id: 'u', email: 'u@corp.com', name: 'U', role, workspaceId: 'ws-1' }) as never;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(
      `CREATE TABLE "${table}" (id serial PRIMARY KEY, cliente_id text NOT NULL, nombre text, email text, alta date, saldo numeric(10,2))`,
    );
    await admin.query(
      `INSERT INTO "${table}" (cliente_id, nombre, email, alta, saldo) VALUES
        ('C1', 'Ana', 'ana@corp.com', '2026-01-10', 10.50),
        ('C2', 'Luis', 'luis@corp.com', '2026-02-11', 0),
        ($1, 'Luna', 'luna@corp.com', NULL, NULL)`,
      [lunaId.toHexString()],
    );

    mongo = await MongoMemoryServer.create();
    seed = await MongoClient.connect(mongo.getUri());
    await seed.db('eventos').collection('pedidos').insertMany([
      { cliente_ref: 'C1', total: 120, estado: 'pagado' },
      { cliente_ref: 'C1', total: 80, estado: 'pendiente' },
      { cliente_ref: 'C9', total: 50, estado: 'pagado' },
    ]);
    await seed.db('eventos').collection('perfiles').insertOne({ _id: lunaId, plan: 'pro' });
  }, 180_000);

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS "${table}"`).catch(() => undefined);
    await admin.end();
    await seed?.close();
    await mongo?.stop();
  });

  afterEach(async () => {
    await pool?.onModuleDestroy();
  });

  const build = () => {
    pool = new DataSourceClientPool();
    const registry = new AdapterRegistry([new PostgresAdapter(pool), new MongoDbAdapter(pool)]);
    const connections: Record<string, unknown> = {
      'pg-1': { id: 'pg-1', tipoMotor: 'POSTGRESQL', dbName: pgUrl.pathname.slice(1), connectionString: pgUrl.toString() },
      'mongo-1': { id: 'mongo-1', tipoMotor: 'MONGODB', dbName: 'eventos', connectionString: mongo.getUri() },
    };
    const connectionsService = {
      getConnectionForExploration: vi.fn(async (id: string) => connections[id]),
    } as unknown as ConnectionsService;
    engine = new DataEngineService(connectionsService, registry, pool);
  };

  const request = (overrides: Record<string, unknown> = {}) =>
    ({
      conexionSqlId: 'pg-1',
      conexionNoSqlId: 'mongo-1',
      tablaSql: table,
      coleccionNoSql: 'pedidos',
      llaveSql: 'cliente_id',
      llaveNoSql: 'cliente_ref',
      ...overrides,
    }) as never;

  it('cruza clientes de PostgreSQL con pedidos de MongoDB aplicando filtros en cada fuente', async () => {
    build();
    const result = await engine.executeCrossJoin(
      request({
        filtrosSql: [{ campo: 'nombre', operador: 'neq', valor: "x' OR 1=1 --" }],
        filtrosNoSql: [{ campo: 'estado', operador: 'eq', valor: 'pagado' }],
      }),
      actor('OPERADOR'),
    );

    expect(result.total).toBe(1);
    expect(result.data[0]).toMatchObject({
      cliente_id: 'C1',
      nombre: 'Ana',
      email: 'ana@corp.com',
      alta: expect.stringMatching(/^2026-01-1\dT/),
      saldo: '10.50',
      cliente_ref: 'C1',
      total: 120,
      estado: 'pagado',
    });
    expect(typeof result.data[0]._id).toBe('string');
  });

  it('enmascara los campos sensibles para LECTOR', async () => {
    build();
    const result = await engine.executeCrossJoin(request(), actor('LECTOR'));
    expect(result.total).toBe(2);
    for (const row of result.data) expect(row.email).not.toMatch(/^[a-z]+@corp\.com$/);
  });

  it('cruza por _id: el ObjectId de MongoDB coincide con su texto en PostgreSQL', async () => {
    build();
    const result = await engine.executeCrossJoin(request({ coleccionNoSql: 'perfiles', llaveNoSql: '_id' }), actor('OPERADOR'));
    expect(result.total).toBe(1);
    expect(result.data[0]).toMatchObject({ nombre: 'Luna', plan: 'pro', _id: lunaId.toHexString() });
  });

  it('reutiliza los clientes del pool entre joins', async () => {
    build();
    await engine.executeCrossJoin(request(), actor('OPERADOR'));
    await engine.executeCrossJoin(request(), actor('OPERADOR'));
    expect(pool.stats()).toEqual({ size: 2, connections: ['pg-1', 'mongo-1'] });
  });
});
