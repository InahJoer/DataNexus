import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { PostgresAdapter } from './adapters/postgres.adapter.js';
import { MongoDbAdapter } from './adapters/mongodb.adapter.js';
import { DataSourceClientPool } from './pool/data-source-client-pool.js';
import { matchesFilters, type FilterNode } from './filters/filter-tree.js';

/**
 * Issue #31: los filtros avanzados dan el mismo resultado ejecutados en PostgreSQL, en MongoDB (pushdown) y
 * evaluados en memoria (lo que el motor hace con Firestore o con lo que un motor no admite). También comprueba
 * contra la base real que los intentos de inyección se tratan como texto literal.
 */
const DATA = [
  { id: 1, nombre: 'Ana López', email: 'ana@corp.com', alta: '2026-01-10', total: 120, pais: 'NI' },
  { id: 2, nombre: 'Luis Ruiz', email: 'ventas@corp.com', alta: '2026-03-02', total: 50, pais: 'CR' },
  { id: 3, nombre: 'ana maría', email: null, alta: '2025-12-31', total: 300, pais: 'NI' },
  { id: 4, nombre: '100%_real', email: 'x@corp.com', alta: '2026-02-01', total: null, pais: 'HN' },
  { id: 5, nombre: "O'Brien", email: 'ob@otra.com', alta: '2026-04-15', total: 75, pais: null },
  { id: 6, nombre: 'Pedro', email: 'pedro@corp.com', alta: '2026-03-31', total: 1000, pais: 'NI' },
];

const CASES: Array<[string, FilterNode[]]> = [
  ['between de fechas', [{ campo: 'alta', operador: 'between', valor: ['2026-01-01', '2026-03-31'] }]],
  ['between de números', [{ campo: 'total', operador: 'between', valor: [50, 120] }]],
  ['contains sin distinguir mayúsculas', [{ campo: 'nombre', operador: 'contains', valor: 'ANA' }]],
  ['startsWith', [{ campo: 'email', operador: 'startsWith', valor: 'VENTAS' }]],
  ['contains con % y _ literales', [{ campo: 'nombre', operador: 'contains', valor: '%_' }]],
  ['contains con comilla', [{ campo: 'nombre', operador: 'contains', valor: "o'b" }]],
  ['isNull true', [{ campo: 'email', operador: 'isNull', valor: true }]],
  ['isNull false', [{ campo: 'total', operador: 'isNull', valor: false }]],
  ['neq excluye nulos', [{ campo: 'pais', operador: 'neq', valor: 'NI' }]],
  ['not-in excluye nulos', [{ campo: 'pais', operador: 'not-in', valor: ['CR'] }]],
  [
    'AND con grupo OR',
    [
      { campo: 'pais', operador: 'eq', valor: 'NI' },
      { logica: 'OR', filtros: [{ campo: 'total', operador: 'gt', valor: 200 }, { campo: 'email', operador: 'contains', valor: 'ana' }] },
    ],
  ],
  [
    'grupos anidados',
    [
      {
        logica: 'OR',
        filtros: [
          { campo: 'pais', operador: 'eq', valor: 'HN' },
          { logica: 'AND', filtros: [{ campo: 'alta', operador: 'gte', valor: '2026-03-01' }, { campo: 'total', operador: 'lt', valor: 100 }] },
        ],
      },
    ],
  ],
  ['inyección en eq', [{ campo: 'nombre', operador: 'eq', valor: "x' OR '1'='1" }]],
  ['inyección en contains', [{ campo: 'nombre', operador: 'contains', valor: "%' OR 1=1 --" }]],
  ['inyección en startsWith', [{ campo: 'email', operador: 'startsWith', valor: "'; DROP TABLE x; --" }]],
];

const expected = (filters: FilterNode[]) => DATA.filter((row) => matchesFilters(row, filters)).map((row) => row.id);
const sortedIds = (rows: Array<Record<string, any>>) => rows.map((row) => Number(row.id)).sort((a, b) => a - b);

describe.skipIf(!process.env.DATABASE_URL)('Filtros avanzados contra PostgreSQL y MongoDB reales (issue #31)', () => {
  const table = `dn_it_filtros_${Date.now()}`;
  const pgUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/x');
  pgUrl.search = '';
  const admin = new Client({ connectionString: pgUrl.toString() });
  const pool = new DataSourceClientPool();
  const postgres = new PostgresAdapter(pool);
  const mongoAdapter = new MongoDbAdapter(pool);
  let mongo: MongoMemoryServer;
  let seed: MongoClient;
  const pgConnection = { id: 'pg-f', tipoMotor: 'POSTGRESQL', dbName: pgUrl.pathname.slice(1), connectionString: pgUrl.toString() };
  let mongoConnection: { id: string; tipoMotor: string; dbName: string; connectionString: string };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(
      `CREATE TABLE "${table}" (id int PRIMARY KEY, nombre text, email text, alta date, total numeric, pais text)`,
    );
    for (const row of DATA) {
      await admin.query(`INSERT INTO "${table}" VALUES ($1, $2, $3, $4, $5, $6)`, [
        row.id,
        row.nombre,
        row.email,
        row.alta,
        row.total,
        row.pais,
      ]);
    }
    mongo = await MongoMemoryServer.create();
    seed = await MongoClient.connect(mongo.getUri());
    await seed.db('crm').collection('clientes').insertMany(DATA.map((row) => ({ ...row })));
    mongoConnection = { id: 'mongo-f', tipoMotor: 'MONGODB', dbName: 'crm', connectionString: mongo.getUri() };
  }, 180_000);

  afterAll(async () => {
    await pool.onModuleDestroy();
    await admin.query(`DROP TABLE IF EXISTS "${table}"`).catch(() => undefined);
    await admin.end();
    await seed?.close();
    await mongo?.stop();
  });

  it.each(CASES)('%s: PostgreSQL devuelve lo mismo que la evaluación en memoria', async (_label, filters) => {
    const rows = await postgres.extract(pgConnection, table, { schema: 'public', filters });
    expect(sortedIds(rows)).toEqual(expected(filters));
  });

  it.each(CASES)('%s: MongoDB devuelve lo mismo que la evaluación en memoria', async (_label, filters) => {
    const rows = await mongoAdapter.extract(mongoConnection, 'clientes', { filters });
    expect(sortedIds(rows)).toEqual(expected(filters));
  });

  it('la tabla sigue intacta después de los intentos de inyección', async () => {
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM "${table}"`);
    expect(rows[0].n).toBe(DATA.length);
  });
});
