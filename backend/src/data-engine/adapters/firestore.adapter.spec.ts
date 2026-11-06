import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

const mocks = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  terminate: vi.fn(),
  collection: vi.fn(),
  listCollections: vi.fn(),
  filterCalls: [] as Array<[string, string, unknown]>,
  limit: vi.fn(),
  documents: [] as Array<{ id: string; data: Record<string, unknown> }>,
  pageCalls: [] as Array<[string, unknown]>,
}));

vi.mock('@google-cloud/firestore', () => ({
  Firestore: vi.fn(function (options: Record<string, unknown>) {
    mocks.options.push(options);
    return { collection: mocks.collection, listCollections: mocks.listCollections, terminate: mocks.terminate };
  }),
  FieldPath: { documentId: () => '__name__' },
}));

import { FirestoreAdapter } from './firestore.adapter.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';

const account = {
  type: 'service_account',
  project_id: 'project-1',
  client_email: 'reader@project-1.iam.gserviceaccount.com',
  private_key: 'private-key',
};
const connection = {
  id: 'firestore-1',
  tipoMotor: 'FIRESTORE',
  dbName: 'orders-db',
  connectionString: JSON.stringify(account),
};

describe('FirestoreAdapter', () => {
  let pool: DataSourceClientPool;
  let adapter: FirestoreAdapter;

  beforeEach(() => {
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_ROWS', '5');
    mocks.options.length = 0;
    mocks.filterCalls.length = 0;
    mocks.documents = [{ id: 'doc-1', data: { total: 10, createdAt: new Date('2026-01-01T00:00:00Z') } }];
    mocks.terminate.mockReset().mockResolvedValue(undefined);
    const query: Record<string, any> = {};
    query.where = vi.fn((field: string, operator: string, value: unknown) => {
      mocks.filterCalls.push([field, operator, value]);
      return query;
    });
    query.limit = mocks.limit.mockReset().mockImplementation(() => query);
    mocks.pageCalls.length = 0;
    query.orderBy = vi.fn((field: unknown) => (mocks.pageCalls.push(['orderBy', field]), query));
    query.startAfter = vi.fn((value: unknown) => (mocks.pageCalls.push(['startAfter', value]), query));
    query.stream = () =>
      Readable.from(
        mocks.documents.map((doc) => ({ id: doc.id, data: () => doc.data })),
        { objectMode: true },
      );
    query.get = vi.fn(async () => ({
      empty: mocks.documents.length === 0,
      docs: mocks.documents.map((doc) => ({ id: doc.id, data: () => doc.data })),
    }));
    mocks.collection.mockReset().mockReturnValue(query);
    mocks.listCollections.mockReset().mockResolvedValue([{ id: 'orders' }, { id: 'clients' }]);
    pool = new DataSourceClientPool();
    adapter = new FirestoreAdapter(pool);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool.onModuleDestroy();
  });

  it('se autentica con la cuenta de servicio y usa la base del registro', async () => {
    const rows = await adapter.extract(connection, 'orders');
    expect(mocks.options[0]).toMatchObject({
      projectId: 'project-1',
      databaseId: 'orders-db',
      credentials: { client_email: account.client_email, private_key: 'private-key' },
    });
    expect(mocks.collection).toHaveBeenCalledWith('orders');
    expect(mocks.limit).toHaveBeenCalledWith(6);
    expect(rows).toEqual([{ total: 10, createdAt: '2026-01-01T00:00:00.000Z', __documentId: 'doc-1' }]);
  });

  it('usa la base por defecto cuando dbName es (default)', async () => {
    await adapter.listObjects({ ...connection, dbName: '(default)' });
    expect(mocks.options[0].databaseId).toBeUndefined();
  });

  it('reutiliza el cliente entre operaciones y lo cierra al invalidar', async () => {
    await expect(adapter.listObjects(connection)).resolves.toEqual([
      { name: 'orders', type: 'COLLECTION' },
      { name: 'clients', type: 'COLLECTION' },
    ]);
    await expect(adapter.listFields(connection, 'orders')).resolves.toEqual(['total', 'createdAt']);
    await adapter.extract(connection, 'orders');
    expect(mocks.options).toHaveLength(1);
    expect(mocks.terminate).not.toHaveBeenCalled();

    await pool.invalidate('firestore-1');
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it('envía los filtros a Firestore antes de leer', async () => {
    await adapter.extract(connection, 'orders', {
      filters: [
        { campo: 'status', operador: 'eq', valor: 'paid' },
        { campo: 'total', operador: 'gte', valor: 10 },
        { campo: 'region', operador: 'not-in', valor: ['x', 'y'] },
      ],
    } as never);
    expect(mocks.filterCalls).toEqual([
      ['status', '==', 'paid'],
      ['total', '>=', 10],
      ['region', 'not-in', ['x', 'y']],
    ]);
  });

  it('traduce between a dos where e isNull a == / != null (issue #31)', async () => {
    await adapter.extract(connection, 'orders', {
      filters: [
        { campo: 'createdAt', operador: 'between', valor: ['2026-01-01', '2026-01-31'] },
        { campo: 'deletedAt', operador: 'isNull', valor: true },
        { campo: 'paidAt', operador: 'isNull', valor: false },
      ],
    });
    expect(mocks.filterCalls).toEqual([
      ['createdAt', '>=', '2026-01-01'],
      ['createdAt', '<=', '2026-01-31'],
      ['deletedAt', '==', null],
      ['paidAt', '!=', null],
    ]);
  });

  it('pagina por id de documento con startAfter; solo las igualdades van al servidor (issue #32)', async () => {
    mocks.documents = [
      { id: 'a1', data: { estado: 'pagado', total: 5 } },
      { id: 'a2', data: { estado: 'pagado', total: 50 } },
      { id: 'a3', data: { estado: 'pagado', total: 70 } },
    ];
    const page = await adapter.readPage(connection, 'orders', {
      pageSize: 2,
      after: ['a0'],
      filters: [
        { campo: 'estado', operador: 'eq', valor: 'pagado' },
        { campo: 'total', operador: 'gt', valor: 10 },
      ],
    });
    expect(mocks.filterCalls).toEqual([['estado', '==', 'pagado']]);
    expect(mocks.pageCalls).toEqual([
      ['orderBy', '__name__'],
      ['startAfter', 'a0'],
    ]);
    expect(mocks.limit).toHaveBeenCalledWith(3);
    // total > 10 se aplica a la página; el cursor avanza por el último documento leído (a2).
    expect(page.rows.map((row) => row.__documentId)).toEqual(['a2']);
    expect(page.lastKey).toEqual(['a2']);
    expect(page.orderBy).toEqual(['__documentId']);
  });

  it('rechaza un cursor de Firestore que no es un id de documento', async () => {
    await expect(adapter.readPage(connection, 'orders', { pageSize: 2, after: [5] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('descarta los documentos con null en != y not-in, igual que SQL', async () => {
    mocks.documents = [
      { id: 'a', data: { region: 'norte' } },
      { id: 'b', data: { region: null } },
    ];
    const rows = await adapter.extract(connection, 'orders', {
      filters: [{ campo: 'region', operador: 'not-in', valor: ['sur'] }],
    });
    expect(rows.map((row) => row.__documentId)).toEqual(['a']);
  });

  it.each([
    ['un grupo OR (lo evalúa el motor en memoria)', { logica: 'OR', filtros: [{ campo: 'a', operador: 'eq', valor: 1 }] }],
    ['contains (lo evalúa el motor en memoria)', { campo: 'status', operador: 'contains', valor: 'pa' }],
    ['un operador desconocido', { campo: 'status', operador: 'like', valor: 'x' }],
    ['un objeto como valor', { campo: 'status', operador: 'eq', valor: { $ne: null } }],
    ['null con un operador de orden', { campo: 'total', operador: 'gt', valor: null }],
    ['una lista de más de 10', { campo: 'id', operador: 'in', valor: Array.from({ length: 11 }, (_, i) => i) }],
  ])('rechaza %s sin consultar', async (_label, filter) => {
    await expect(adapter.extract(connection, 'orders', { filters: [filter] } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mocks.filterCalls).toEqual([]);
    expect(mocks.options).toHaveLength(0);
  });

  it('solo admite colecciones raíz con nombre válido', async () => {
    await expect(adapter.extract(connection, 'orders/abc/items')).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.listFields(connection, '')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza colecciones que superan el máximo de documentos', async () => {
    mocks.documents = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, data: { i } }));
    await expect(adapter.extract(connection, 'orders')).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('rechaza colecciones que superan el máximo de bytes', async () => {
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_BYTES', '40');
    mocks.documents = [{ id: 'd1', data: { text: 'x'.repeat(100) } }];
    await expect(adapter.extract(connection, 'orders')).rejects.toThrow(/bytes configurado/);
  });

  it('conserva un campo llamado __documentId y asigna otra clave al id del documento', async () => {
    mocks.documents = [{ id: 'doc-9', data: { __documentId: 'propio' } }];
    await expect(adapter.extract(connection, 'orders')).resolves.toEqual([
      { __documentId: 'propio', __documentId_2: 'doc-9' },
    ]);
  });

  it('rechaza credenciales que no son JSON o están incompletas', async () => {
    await expect(adapter.listObjects({ ...connection, connectionString: 'no-json' })).rejects.toThrow(
      'La credencial de Firestore debe ser JSON válido',
    );
    await expect(
      adapter.listObjects({ ...connection, connectionString: JSON.stringify({ project_id: 'p' }) }),
    ).rejects.toThrow('La cuenta de servicio de Firestore está incompleta');
  });
});
