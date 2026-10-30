import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { EncryptionService } from '../../common/encryption/encryption.service.js';

const mocks = vi.hoisted(() => ({
  app: { name: 'data-engine-test-app' },
  appConfigs: [] as Array<{ options: Record<string, unknown>; name: string }>,
  accountJson: JSON.stringify({
    project_id: 'project-1',
    client_email: 'reader@project-1.iam.gserviceaccount.com',
    private_key: 'private-key',
  }),
  decrypt: vi.fn(),
  cert: vi.fn(),
  initializeApp: vi.fn(),
  deleteApp: vi.fn(),
  getFirestore: vi.fn(),
  collection: vi.fn(),
  where: vi.fn(),
  filterCalls: [] as Array<[string, string, unknown]>,
  limit: vi.fn(),
  stream: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock('firebase-admin/app', () => ({
  cert: mocks.cert,
  initializeApp: mocks.initializeApp,
  deleteApp: mocks.deleteApp,
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: mocks.getFirestore,
}));

import { FirestoreDataExtractor } from './firestore-data-extractor.js';

const connection = {
  id: 'firestore-1',
  tipoMotor: 'Firebase',
  dbName: 'orders-db',
  encryptedConnectionString: 'encrypted-service-account',
};
const encryptionService = {
  decrypt: mocks.decrypt,
} as unknown as EncryptionService;

describe('FirestoreDataExtractor', () => {
  beforeEach(() => {
    mocks.appConfigs.length = 0;
    mocks.decrypt.mockReset().mockReturnValue(mocks.accountJson);
    mocks.cert.mockReset().mockImplementation((credentials) => credentials);
    mocks.initializeApp.mockReset().mockImplementation((options, name) => {
      mocks.appConfigs.push({ options, name });
      return mocks.app;
    });
    mocks.deleteApp.mockReset().mockResolvedValue(undefined);
    mocks.getFirestore.mockReset().mockReturnValue({
      collection: mocks.collection,
      terminate: mocks.terminate,
    });
    const query = { where: mocks.where, limit: mocks.limit };
    mocks.filterCalls.length = 0;
    mocks.where
      .mockReset()
      .mockImplementation((field: string, operator: string, value: unknown) => {
        mocks.filterCalls.push([field, operator, value]);
        return query;
      });
    mocks.collection.mockReset().mockReturnValue(query);
    mocks.limit
      .mockReset()
      .mockImplementation(() => ({ stream: mocks.stream }));
    mocks.stream.mockReset().mockImplementation(async function* () {
      yield* [
        {
          id: 'order-1',
          data: () => ({
            customer_id: 'C1',
            created_at: new Date('2026-01-02T00:00:00.000Z'),
          }),
        },
      ];
    });
    mocks.terminate.mockReset().mockResolvedValue(undefined);
  });

  it('authenticates with the decrypted service account and reads collection documents', async () => {
    const extractor = new FirestoreDataExtractor(encryptionService, 5);

    const rows = await extractor.extract(connection, 'orders');

    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted-service-account');
    expect(mocks.cert).toHaveBeenCalledWith({
      projectId: 'project-1',
      clientEmail: 'reader@project-1.iam.gserviceaccount.com',
      privateKey: 'private-key',
    });
    expect(mocks.appConfigs[0].options).toMatchObject({
      projectId: 'project-1',
    });
    expect(mocks.getFirestore).toHaveBeenCalledWith(mocks.app, 'orders-db');
    expect(mocks.collection).toHaveBeenCalledWith('orders');
    expect(mocks.limit).toHaveBeenCalledWith(6);
    expect(rows).toEqual([
      {
        customer_id: 'C1',
        created_at: '2026-01-02T00:00:00.000Z',
        __documentId: 'order-1',
      },
    ]);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.deleteApp).toHaveBeenCalledWith(mocks.app);
  });

  it('pushes multiple filters to Firestore before streaming', async () => {
    const extractor = new FirestoreDataExtractor(encryptionService, 5);

    const rows = await extractor.extract(connection, 'orders', {
      filters: [
        { campo: 'customer_id', operador: 'eq', valor: 'C1' },
        { campo: 'total', operador: 'gte', valor: 10 },
      ],
    } as any);

    expect(mocks.filterCalls).toEqual([
      ['customer_id', '==', 'C1'],
      ['total', '>=', 10],
    ]);
    expect(rows).toHaveLength(1);
    expect(mocks.limit).toHaveBeenCalledWith(6);
  });

  it.each([
    ['eq', '==', 'C1'],
    ['eq', '==', null],
    ['neq', '!=', 'C1'],
    ['neq', '!=', null],
    ['gt', '>', 10],
    ['gte', '>=', 10],
    ['lt', '<', 10],
    ['lte', '<=', 10],
    ['in', 'in', ['C1', 'C2']],
    ['not-in', 'not-in', ['C1', 'C2']],
  ])(
    'maps Firestore filter operator %s',
    async (operator, nativeOperator, value) => {
      await new FirestoreDataExtractor(encryptionService, 5).extract(
        connection,
        'orders',
        {
          filters: [{ campo: 'customer_id', operador: operator, valor: value }],
        } as any,
      );

      expect(mocks.filterCalls).toEqual([
        ['customer_id', nativeOperator, value],
      ]);
    },
  );

  it.each([
    { campo: '', operador: 'eq', valor: 'C1' },
    { campo: 'amount', operador: 'gt', valor: null },
    {
      campo: 'customer_id',
      operador: 'in',
      valor: Array.from({ length: 11 }, (_, i) => i),
    },
    { campo: 'customer_id', operador: 'raw', valor: 'C1' },
  ])(
    'rejects invalid source filters before querying Firestore',
    async (filter) => {
      await expect(
        new FirestoreDataExtractor(encryptionService, 5).extract(
          connection,
          'orders',
          { filters: [filter] } as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.filterCalls).toEqual([]);
    },
  );

  it('rejects collections over the row limit and still terminates the client', async () => {
    mocks.stream.mockImplementation(async function* () {
      yield { id: '1', data: () => ({}) };
      yield { id: '2', data: () => ({}) };
      yield { id: '3', data: () => ({}) };
    });
    const extractor = new FirestoreDataExtractor(encryptionService, 2);

    await expect(
      extractor.extract(connection, 'orders'),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.deleteApp).toHaveBeenCalledWith(mocks.app);
  });

  it('keeps a document field named __documentId and assigns the metadata a free key', async () => {
    mocks.stream.mockImplementation(async function* () {
      yield {
        id: 'firestore-id',
        data: () => ({ __documentId: 'business-value' }),
      };
    });

    const rows = await new FirestoreDataExtractor(encryptionService, 5).extract(
      connection,
      'orders',
    );

    expect(rows).toEqual([
      { __documentId: 'business-value', __documentId_2: 'firestore-id' },
    ]);
  });

  it('stops streaming when the source byte cap is exceeded', async () => {
    mocks.stream.mockImplementation(async function* () {
      yield { id: 'large', data: () => ({ value: 'x'.repeat(100) }) };
    });

    await expect(
      new FirestoreDataExtractor(encryptionService, 5, 20).extract(
        connection,
        'orders',
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
});
