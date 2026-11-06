import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { BadRequestException } from '@nestjs/common';
import { Client } from 'pg';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { PostgresAdapter } from '../adapters/postgres.adapter.js';
import { MongoDbAdapter } from '../adapters/mongodb.adapter.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';
import type { CursorValue } from './keyset.js';

/**
 * Criterio de aceptación del #32: recorrer 1.000.000 de registros con paginación nativa sin superar el límite de
 * memoria. Contra PostgreSQL real (DATABASE_URL, en CI) y MongoDB en memoria.
 */
const MILLION = 1_000_000;
const PAGE = 1_000;

describe.skipIf(!process.env.DATABASE_URL)('Paginación por cursor con PostgreSQL real (1M filas)', () => {
  const big = `dn_it_pag_${Date.now()}`;
  const compound = `${big}_comp`;
  const noKey = `${big}_sinpk`;
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/x');
  url.search = '';
  const admin = new Client({ connectionString: url.toString() });
  const pool = new DataSourceClientPool();
  const adapter = new PostgresAdapter(pool);
  const connection = { id: 'pg-pag', tipoMotor: 'POSTGRESQL', dbName: url.pathname.slice(1), connectionString: url.toString() };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE TABLE "${big}" (id bigint PRIMARY KEY, nombre text NOT NULL, pais text NOT NULL)`);
    await admin.query(
      `INSERT INTO "${big}" SELECT g, 'Cliente ' || g, CASE WHEN g % 4 = 0 THEN 'NI' ELSE 'CR' END FROM generate_series(1, ${MILLION}) g`,
    );
    await admin.query(`CREATE TABLE "${compound}" (pais text, id int, nombre text, PRIMARY KEY (pais, id))`);
    await admin.query(
      `INSERT INTO "${compound}" SELECT CASE WHEN g % 3 = 0 THEN 'CR' WHEN g % 3 = 1 THEN 'HN' ELSE 'NI' END, g, 'x' || g FROM generate_series(1, 250) g`,
    );
    await admin.query(`CREATE TABLE "${noKey}" (nombre text)`);
  }, 180_000);

  afterAll(async () => {
    await pool.onModuleDestroy();
    for (const table of [big, compound, noKey]) await admin.query(`DROP TABLE IF EXISTS "${table}"`).catch(() => undefined);
    await admin.end();
  });

  it(
    'recorre 1.000.000 de filas en páginas de 1.000 sin saltos ni repetidos y con memoria constante',
    async () => {
      globalThis.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      let maxHeapDelta = 0;
      let after: CursorValue[] | undefined;
      let seen = 0;
      let expectedId = 1;
      let pages = 0;
      const started = performance.now();

      do {
        const page = await adapter.readPage(connection, big, { schema: 'public', pageSize: PAGE, ...(after ? { after } : {}) });
        for (const row of page.rows) {
          // bigint llega como texto: el orden y la continuidad se comprueban fila a fila.
          if (Number(row.id) !== expectedId) throw new Error(`Fila fuera de orden: ${row.id} en lugar de ${expectedId}`);
          expectedId += 1;
        }
        seen += page.rows.length;
        pages += 1;
        after = page.lastKey ?? undefined;
        if (pages % 100 === 0) {
          // Memoria retenida (tras recolectar basura): debe mantenerse plana aunque se lean más páginas.
          globalThis.gc?.();
          maxHeapDelta = Math.max(maxHeapDelta, process.memoryUsage().heapUsed - heapBefore);
        }
      } while (after);

      const seconds = (performance.now() - started) / 1000;
      console.log(`1M filas en ${pages} páginas: ${seconds.toFixed(1)} s; heap máx. +${(maxHeapDelta / 2 ** 20).toFixed(1)} MB`);
      expect(seen).toBe(MILLION);
      expect(pages).toBe(MILLION / PAGE);
      // Solo hay una página en memoria a la vez: muy por debajo de los 32 MB por fuente.
      expect(maxHeapDelta).toBeLessThan(32 * 2 ** 20);
    },
    300_000,
  );

  it('una página profunda cuesta lo mismo que la primera (keyset, sin OFFSET)', async () => {
    const time = async (after?: CursorValue[]) => {
      const start = performance.now();
      const page = await adapter.readPage(connection, big, { schema: 'public', pageSize: 100, ...(after ? { after } : {}) });
      return { ms: performance.now() - start, first: Number(page.rows[0].id) };
    };
    await time(); // calentamiento
    const firstPage = await time();
    const deepPage = await time(['999800']);
    expect(deepPage.first).toBe(999_801);
    expect(firstPage.first).toBe(1);
    expect(deepPage.ms).toBeLessThan(Math.max(firstPage.ms * 10, 200));
    const plan = await admin.query(`EXPLAIN SELECT * FROM "${big}" WHERE id > 999800 ORDER BY id LIMIT 101`);
    expect(JSON.stringify(plan.rows)).toMatch(/Index Scan/);
  });

  it('combina filtros con la paginación', async () => {
    const first = await adapter.readPage(connection, big, {
      schema: 'public',
      pageSize: 3,
      filters: [{ campo: 'pais', operador: 'eq', valor: 'NI' }],
    });
    expect(first.rows.map((row) => Number(row.id))).toEqual([4, 8, 12]);
    const second = await adapter.readPage(connection, big, {
      schema: 'public',
      pageSize: 3,
      filters: [{ campo: 'pais', operador: 'eq', valor: 'NI' }],
      after: first.lastKey!,
    });
    expect(second.rows.map((row) => Number(row.id))).toEqual([16, 20, 24]);
  });

  it('pagina por llave primaria compuesta sin saltos', async () => {
    const ids: string[] = [];
    let after: CursorValue[] | undefined;
    do {
      const page = await adapter.readPage(connection, compound, { schema: 'public', pageSize: 7, ...(after ? { after } : {}) });
      expect(page.orderBy).toEqual(['pais', 'id']);
      ids.push(...page.rows.map((row) => `${row.pais}-${row.id}`));
      after = page.lastKey ?? undefined;
    } while (after);
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
    expect(ids.slice(0, 2)).toEqual(['CR-3', 'CR-6']);
  });

  it('una tabla sin llave primaria responde 400 con un mensaje claro', async () => {
    await expect(adapter.readPage(connection, noKey, { schema: 'public', pageSize: 10 })).rejects.toThrow(
      /no tiene llave primaria/,
    );
  });

  it('un cursor con valores maliciosos se trata como dato', async () => {
    await expect(
      adapter.readPage(connection, big, { schema: 'public', pageSize: 5, after: ["0; DROP TABLE x; --"] }),
    ).rejects.toThrow(); // PostgreSQL rechaza el texto como bigint: nunca se ejecuta como SQL
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM "${big}"`);
    expect(rows[0].n).toBe(MILLION);
  });
});

describe('Paginación por cursor con MongoDB real (mongodb-memory-server)', () => {
  const TOTAL = 20_000;
  let server: MongoMemoryServer;
  let seed: MongoClient;
  const pool = new DataSourceClientPool();
  const adapter = new MongoDbAdapter(pool);
  let connection: { id: string; tipoMotor: string; dbName: string; connectionString: string };

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    seed = await MongoClient.connect(server.getUri());
    const db = seed.db('eventos');
    await db.collection('clics').insertMany(Array.from({ length: TOTAL }, (_, i) => ({ n: i, canal: i % 2 ? 'web' : 'app' })));
    await db.collection('codigos').insertMany(Array.from({ length: 30 }, (_, i) => ({ _id: `C${String(i).padStart(3, '0')}` as never })));
    connection = { id: 'mongo-pag', tipoMotor: 'MONGODB', dbName: 'eventos', connectionString: server.getUri() };
  }, 180_000);

  afterAll(async () => {
    await pool.onModuleDestroy();
    await seed?.close();
    await server?.stop();
  });

  it('recorre la colección completa por _id (ObjectId) sin saltos ni repetidos', async () => {
    const seen = new Set<number>();
    let after: CursorValue[] | undefined;
    let pages = 0;
    do {
      const page = await adapter.readPage(connection, 'clics', { pageSize: PAGE, ...(after ? { after } : {}) });
      expect(page.orderBy).toEqual(['_id']);
      for (const row of page.rows) {
        expect(ObjectId.isValid(row._id)).toBe(true);
        seen.add(row.n);
      }
      pages += 1;
      after = page.lastKey ?? undefined;
    } while (after);
    expect(seen.size).toBe(TOTAL);
    expect(pages).toBe(TOTAL / PAGE);
  });

  it('pagina _id de texto y combina filtros', async () => {
    const first = await adapter.readPage(connection, 'codigos', { pageSize: 10 });
    expect(first.lastKey).toEqual(['C009']);
    const second = await adapter.readPage(connection, 'codigos', { pageSize: 10, after: first.lastKey! });
    expect(second.rows[0]._id).toBe('C010');

    const filtered = await adapter.readPage(connection, 'clics', {
      pageSize: 5,
      filters: [{ campo: 'canal', operador: 'eq', valor: 'web' }],
    });
    expect(filtered.rows.every((row) => row.canal === 'web')).toBe(true);
  });

  it('rechaza un cursor de otra forma', async () => {
    await expect(adapter.readPage(connection, 'clics', { pageSize: 5, after: ['a', 'b'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
