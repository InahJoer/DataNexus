import { Firestore } from '@google-cloud/firestore';
import type { CatalogObject, DataExplorer } from '../data-explorer.interface.js';

interface FirestoreServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

export class FirestoreDataExplorer implements DataExplorer {
  readonly tipoMotor = 'Firestore';
  private firestore?: Firestore;

  async listObjects(connectionString: string, dbName: string): Promise<CatalogObject[]> {
    const firestore = this.connect(connectionString, dbName);
    const collections = await firestore.listCollections();
    return collections.map((collection) => ({ name: collection.id, type: 'COLLECTION' }));
  }

  async listFields(connectionString: string, dbName: string, collectionName: string): Promise<string[]> {
    const firestore = this.firestore ?? this.connect(connectionString, dbName);
    const snapshot = await firestore.collection(collectionName).limit(1).get();
    if (snapshot.empty) return [];
    return Object.keys(snapshot.docs[0].data() ?? {});
  }

  private connect(connectionString: string, dbName: string): Firestore {
    const account = JSON.parse(connectionString) as FirestoreServiceAccount;
    if (!account.project_id || !account.client_email || !account.private_key) {
      throw new Error('Invalid Firestore service account');
    }

    this.firestore = new Firestore({
      projectId: account.project_id,
      databaseId: dbName && dbName !== '(default)' ? dbName : undefined,
      credentials: {
        client_email: account.client_email,
        private_key: account.private_key,
      },
      clientConfig: {
        interfaces: {
          'google.firestore.v1.Firestore': {
            methods: {
              ListCollectionIds: {
                timeout_millis: 8_000,
                retry_codes_name: 'non_idempotent',
                retry_params_name: 'default',
              },
            },
          },
        },
      },
    });

    return this.firestore;
  }

  async cancel(): Promise<void> {
    const firestore = this.firestore;
    this.firestore = undefined;
    if (firestore) await firestore.terminate().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.cancel();
  }
}
