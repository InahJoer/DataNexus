import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsController } from './connections.controller.js';
import type { ConnectionsService } from './connections.service.js';
import type { ConnectionTestService } from './connection-test.service.js';

const { createClient, listDatabases, close } = vi.hoisted(() => ({
  createClient: vi.fn(),
  listDatabases: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@google-cloud/firestore', () => ({
  v1: {
    FirestoreAdminClient: class {
      constructor(options: unknown) {
        createClient(options);
      }
      listDatabases = listDatabases;
      close = close;
    },
  },
}));

const input = {
  serviceAccount: {
    type: 'service_account',
    project_id: 'datanexus-demo',
    client_email: 'reader@datanexus-demo.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n',
  },
};

describe('Firestore database discovery', () => {
  const controller = new ConnectionsController({} as ConnectionsService, {} as ConnectionTestService);

  beforeEach(() => {
    vi.resetAllMocks();
    close.mockResolvedValue(undefined);
  });

  it('lists only native Firestore database IDs from the credential project', async () => {
    listDatabases.mockResolvedValue([{
      databases: [
        { name: 'projects/datanexus-demo/databases/ventas', type: 'FIRESTORE_NATIVE' },
        { name: 'projects/datanexus-demo/databases/(default)', type: 'FIRESTORE_NATIVE' },
        { name: 'projects/datanexus-demo/databases/legacy', type: 'DATASTORE_MODE' },
      ],
      unreachable: ['projects/datanexus-demo/locations/example'],
    }]);

    await expect(controller.listFirestoreDatabases(input)).resolves.toEqual({
      databaseIds: ['(default)', 'ventas'],
      partial: true,
    });
    expect(listDatabases).toHaveBeenCalledWith({ parent: 'projects/datanexus-demo' }, expect.any(Object));
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects invalid credentials without creating a Google client', async () => {
    await expect(controller.listFirestoreDatabases({ serviceAccount: {} })).rejects.toThrow(BadRequestException);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('reports a missing listing permission without exposing the upstream error', async () => {
    listDatabases.mockRejectedValue({ code: 7, message: 'upstream details' });
    await expect(controller.listFirestoreDatabases(input)).rejects.toThrow(ForbiddenException);
    expect(close).toHaveBeenCalledOnce();
  });
});
