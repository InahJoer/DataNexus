import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoDbAdapter } from './mongodb.adapter.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';
import { MongoDbConnectionTester } from '../../connections/testing/mongodb-connection-tester.js';
import { normalizeConnectionError } from '../../connections/testing/connection-error.normalizer.js';

/** Adaptador y prueba de conexión de MongoDB contra un mongod real en memoria (issue #29). */
describe('MongoDbAdapter con MongoDB real (mongodb-memory-server)', () => {
  let server: MongoMemoryServer;
  let seed: MongoClient;
  let pool: DataSourceClientPool;
  let adapter: MongoDbAdapter;
  let connection: { id: string; tipoMotor: string; dbName: string; connectionString: string };
  const anaId = new ObjectId();

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    seed = await MongoClient.connect(server.getUri());
    const db = seed.db('ventas');
    await db.collection('clientes').insertMany([
      { _id: anaId, nombre: 'Ana', pais: 'NI', total: 120, alta: new Date('2026-01-10T00:00:00Z') },
      { nombre: 'Luis', pais: 'CR', total: 50, vip: true },
      { nombre: 'Marta', pais: 'NI', total: 300, baja: null },
    ]);
    await db.createCollection('vacia');
    await db.createCollection('clientes_ni', { viewOn: 'clientes', pipeline: [{ $match: { pais: 'NI' } }] });
    connection = { id: 'mongo-1', tipoMotor: 'MONGODB', dbName: 'ventas', connectionString: server.getUri() };
  }, 180_000);

  afterAll(async () => {
    await seed?.close();
    await server?.stop();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool?.onModuleDestroy();
  });

  const fresh = () => {
    pool = new DataSourceClientPool();
    adapter = new MongoDbAdapter(pool);
  };

  it('lista colecciones y vistas de la base configurada', async () => {
    fresh();
    await expect(adapter.listObjects(connection)).resolves.toEqual([
      { name: 'clientes', schema: 'ventas', type: 'COLLECTION' },
      { name: 'clientes_ni', schema: 'ventas', type: 'VIEW' },
      { name: 'vacia', schema: 'ventas', type: 'COLLECTION' },
    ]);
  });

  it('infiere los campos por muestreo (unión de claves, _id primero)', async () => {
    fresh();
    const fields = await adapter.listFields(connection, 'clientes');
    expect(fields[0]).toBe('_id');
    expect([...fields].sort()).toEqual(['_id', 'alta', 'baja', 'nombre', 'pais', 'total', 'vip']);
    await expect(adapter.listFields(connection, 'vacia')).resolves.toEqual([]);
  });

  it('extrae con filtros en el servidor y normaliza ObjectId y fechas', async () => {
    fresh();
    const rows = await adapter.extract(connection, 'clientes', {
      filters: [
        { campo: 'pais', operador: 'eq', valor: 'NI' },
        { campo: 'total', operador: 'lt', valor: 200 },
      ],
    });
    expect(rows).toEqual([
      { _id: anaId.toHexString(), nombre: 'Ana', pais: 'NI', total: 120, alta: '2026-01-10T00:00:00.000Z' },
    ]);
  });

  it('una inyección por el valor del filtro no devuelve datos de más', async () => {
    fresh();
    await expect(
      adapter.extract(connection, 'clientes', { filters: [{ campo: 'nombre', operador: 'eq', valor: "' || '1'=='1" }] }),
    ).resolves.toEqual([]);
    await expect(
      adapter.extract(connection, 'clientes', { filters: [{ campo: 'nombre', operador: 'neq', valor: { $gt: '' } } as never] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('corta con 413 si la colección supera el máximo de documentos o de bytes', async () => {
    fresh();
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_ROWS', '2');
    await expect(adapter.extract(connection, 'clientes')).rejects.toBeInstanceOf(PayloadTooLargeException);
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_ROWS', '100');
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_BYTES', '150');
    await expect(adapter.extract(connection, 'clientes')).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('rechaza colecciones internas o con nombre inválido antes de consultar', async () => {
    fresh();
    await expect(adapter.extract(connection, 'system.users')).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.listFields(connection, '$cmd')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reutiliza un solo MongoClient entre operaciones y lo cierra al invalidar', async () => {
    fresh();
    await adapter.listObjects(connection);
    await adapter.extract(connection, 'clientes');
    expect(pool.stats()).toEqual({ size: 1, connections: ['mongo-1'] });
    await pool.invalidate('mongo-1');
    expect(pool.stats().size).toBe(0);
  });

  it('rechaza URIs que no son de MongoDB', async () => {
    fresh();
    await expect(adapter.listObjects({ ...connection, connectionString: 'postgres://x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe('Probar conexión (MongoDbConnectionTester)', () => {
    it('responde con la versión del servidor', async () => {
      const tester = new MongoDbConnectionTester();
      try {
        const result = await tester.ping(server.getUri(), 'ventas', 5_000);
        expect(result.serverVersion).toMatch(/^MongoDB \d+\.\d+/);
      } finally {
        await tester.close();
      }
    });

    it('un puerto cerrado se traduce a un error legible sin datos de conexión', async () => {
      const tester = new MongoDbConnectionTester();
      const error = await tester.ping('mongodb://127.0.0.1:1/', 'ventas', 1_000).catch((e: unknown) => e);
      await tester.close();
      const normalized = normalizeConnectionError(error, 'MONGODB', 1_000);
      expect(['CONNECTION_REFUSED', 'TIMEOUT']).toContain(normalized.code);
      expect(normalized.message).not.toContain('127.0.0.1');
    });

    it('rechaza una URI inválida antes de contactar al servidor', async () => {
      const tester = new MongoDbConnectionTester();
      await expect(tester.ping('http://x', 'ventas', 1_000)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
      await tester.close();
    });
  });
});
