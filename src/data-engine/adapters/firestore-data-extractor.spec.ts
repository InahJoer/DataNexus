import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PayloadTooLargeException } from '@nestjs/common';
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
    mocks.collection
      .mockReset()
      .mockImplementation(() => ({ limit: mocks.limit }));
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
    expect(mocks.getFirestore).toHaveBeenCalledWith(
      mocks.app,
      'orders-db',
    );
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

    const rows = await new FirestoreDataExtractor(
      encryptionService,
      5,
    ).extract(connection, 'orders');

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
