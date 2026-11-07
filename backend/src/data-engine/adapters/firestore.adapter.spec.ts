import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

const mocks = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  terminate: vi.fn(),
  collection: vi.fn(),
  collectionGroup: vi.fn(),
  listCollections: vi.fn(),
  filterCalls: [] as Array<[string, string, unknown]>,
  limit: vi.fn(),
  documents: [] as Array<{ id: string; data: Record<string, unknown>; path?: string }>,
  pageCalls: [] as Array<[string, unknown]>,
}));

vi.mock('@google-cloud/firestore', () => ({
  Firestore: vi.fn(function (options: Record<string, unknown>) {
    mocks.options.push(options);
    return {
      collection: mocks.collection,
      collectionGroup: mocks.collectionGroup,
      listCollections: mocks.listCollections,
      terminate: mocks.terminate,
    };
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
/** Documento simulado con su referencia (ruta y documento padre, como en Firestore). */
function snapshot(doc: { id: string; data: Record<string, unknown>; path?: string }) {
  const path = doc.path ?? `orders/${doc.id}`;
  const parts = path.split('/');
  return { id: doc.id, data: () => doc.data, ref: { path, parent: { parent: parts.length >= 4 ? { id: parts[parts.length - 3] } : null } } };
}

/** Colección raíz simulada; `subcollections` son las subcolecciones de su primer documento. */
function rootCollection(id: string, subcollections: string[] = []) {
  return {
    id,
    limit: () => ({
      get: async () => ({
        docs: subcollections.length ? [{ ref: { listCollections: async () => subcollections.map((sub) => ({ id: sub })) } }] : [],
      }),
    }),
  };
}

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
        mocks.documents.map(snapshot),
        { objectMode: true },
      );
    query.get = vi.fn(async () => ({
      empty: mocks.documents.length === 0,
      docs: mocks.documents.map(snapshot),
    }));
    mocks.collection.mockReset().mockReturnValue(query);
    mocks.collectionGroup.mockReset().mockReturnValue(query);
    mocks.listCollections.mockReset().mockResolvedValue([rootCollection('orders'), rootCollection('clients')]);
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

  it('no envía rangos de fechas al servidor: un Timestamp no se compara con texto ISO y se filtra en memoria', () => {
    expect(adapter.canPushDown({ campo: 'createdAt', operador: 'between', valor: ['2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.999Z'] })).toBe(false);
    expect(adapter.canPushDown({ campo: 'createdAt', operador: 'gte', valor: '2026-01-01' })).toBe(false);
    expect(adapter.canPushDown({ campo: 'total', operador: 'between', valor: [1, 2] })).toBe(true);
    expect(adapter.canPushDown({ campo: 'estado', operador: 'gte', valor: 'b' })).toBe(true);
  });

  it('traduce between a dos where e isNull a == / != null (issue #31)', async () => {
    await adapter.extract(connection, 'orders', {
      filters: [
        { campo: 'total', operador: 'between', valor: [10, 50] },
        { campo: 'deletedAt', operador: 'isNull', valor: true },
        { campo: 'paidAt', operador: 'isNull', valor: false },
      ],
    });
    expect(mocks.filterCalls).toEqual([
      ['total', '>=', 10],
      ['total', '<=', 50],
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

  it('valida la ruta de la colección: raíz, subcolección de un documento o grupo padre/*/sub', async () => {
    for (const invalid of ['', 'orders/abc', 'orders/*/items/x', '*/items', 'orders/__name__/items', 'orders/../items']) {
      await expect(adapter.listFields(connection, invalid)).rejects.toBeInstanceOf(BadRequestException);
    }
    await adapter.extract(connection, 'clients/c-1/orders');
    expect(mocks.collection).toHaveBeenCalledWith('clients/c-1/orders');
  });

  it('descubre subcolecciones en una muestra de documentos y las lista como grupos padre/*/sub', async () => {
    mocks.listCollections.mockResolvedValue([rootCollection('clients', ['orders', 'notes']), rootCollection('products')]);
    await expect(adapter.listObjects(connection)).resolves.toEqual([
      { name: 'clients', type: 'COLLECTION' },
      { name: 'products', type: 'COLLECTION' },
      { name: 'clients/*/notes', type: 'COLLECTION' },
      { name: 'clients/*/orders', type: 'COLLECTION' },
    ]);
  });

  it('un grupo lee todas las subcolecciones del padre, con __parentId y __path, y descarta las de otros padres', async () => {
    mocks.documents = [
      { id: 'o-1', data: { total: 10 }, path: 'clients/c-1/orders/o-1' },
      { id: 'o-2', data: { total: 20 }, path: 'clients/c-2/orders/o-2' },
      { id: 'o-3', data: { total: 30 }, path: 'suppliers/s-1/orders/o-3' },
      { id: 'o-4', data: { total: 40 }, path: 'clients/c-1/orders/o-4/orders/o-5' },
    ];
    const rows = await adapter.extract(connection, 'clients/*/orders', { filters: [{ campo: 'total', operador: 'gte', valor: 15 }] });
    expect(mocks.collectionGroup).toHaveBeenCalledWith('orders');
    // Los filtros de un grupo se evalúan en memoria (en el servidor pedirían índices de grupo de colecciones).
    expect(mocks.filterCalls).toEqual([]);
    expect(rows).toEqual([{ total: 20, __documentId: 'o-2', __parentId: 'c-2', __path: 'clients/c-2/orders/o-2' }]);
    await expect(adapter.listFields(connection, 'clients/*/orders')).resolves.toEqual(['__parentId', 'total']);
  });

  it('pagina un grupo por ruta completa y la expone como columna de orden', async () => {
    mocks.documents = [
      { id: 'o-1', data: { total: 10 }, path: 'clients/c-1/orders/o-1' },
      { id: 'o-2', data: { total: 20 }, path: 'clients/c-2/orders/o-2' },
    ];
    const page = await adapter.readPage(connection, 'clients/*/orders', { pageSize: 1, after: ['clients/c-0/orders/o-0'] });
    expect(mocks.pageCalls).toEqual([['orderBy', '__name__'], ['startAfter', 'clients/c-0/orders/o-0']]);
    expect(page.orderBy).toEqual(['__path']);
    expect(page.lastKey).toEqual(['clients/c-1/orders/o-1']);
    expect(page.rows).toEqual([{ total: 10, __documentId: 'o-1', __parentId: 'c-1', __path: 'clients/c-1/orders/o-1' }]);
  });

  it('para editar un documento de un grupo exige su ruta completa dentro de ese grupo', async () => {
    const base = { entityName: 'clients/*/orders', field: 'total', expectedValue: 1, nextValue: 2 };
    for (const primaryKey of ['o-1', 'suppliers/s-1/orders/o-1', 'clients/c-1/notes/o-1']) {
      await expect(adapter.updateRecord(connection, { ...base, primaryKey })).rejects.toBeInstanceOf(BadRequestException);
    }
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
