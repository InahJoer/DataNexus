import { Firestore } from '@google-cloud/firestore';
import {
  InvalidConnectionConfigError,
  type ConnectionPingResult,
  type ConnectionTester,
} from './connection-tester.interface.js';

interface FirestoreServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

export class FirestoreConnectionTester implements ConnectionTester {
  private firestore?: Firestore;

  async ping(connectionString: string, dbName: string, timeoutMs: number): Promise<ConnectionPingResult> {
    let account: FirestoreServiceAccount;
    try {
      account = JSON.parse(connectionString) as FirestoreServiceAccount;
    } catch {
      throw new InvalidConnectionConfigError('Cuenta de servicio de Firestore inválida');
    }
    if (!account?.project_id || !account.client_email || !account.private_key) {
      throw new InvalidConnectionConfigError('Cuenta de servicio de Firestore inválida');
    }

    const databaseId = dbName && dbName !== '(default)' ? dbName : undefined;
    this.firestore = new Firestore({
      projectId: account.project_id,
      databaseId,
      credentials: {
        client_email: account.client_email,
        private_key: account.private_key,
      },
      clientConfig: {
        interfaces: {
          'google.firestore.v1.Firestore': {
            methods: {
              ListCollectionIds: {
                timeout_millis: timeoutMs,
                retry_codes_name: 'non_idempotent',
                retry_params_name: 'default',
              },
            },
          },
        },
      },
    });

    // Autentica la cuenta de servicio y confirma acceso de lectura a la base.
    await this.firestore.listCollections();
    // Firestore es un servicio gestionado y no expone versión de servidor.
    return { serverVersion: `Cloud Firestore (${databaseId ?? '(default)'})` };
  }

  async close(): Promise<void> {
    const firestore = this.firestore;
    this.firestore = undefined;
    if (firestore) await firestore.terminate().catch(() => undefined);
  }
}
