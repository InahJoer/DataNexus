import { MongoClient } from 'mongodb';
import {
  InvalidConnectionConfigError,
  type ConnectionPingResult,
  type ConnectionTester,
} from './connection-tester.interface.js';

/**
 * Prueba de conexión de MongoDB: selecciona servidor, autentica y lista las colecciones de la base indicada
 * (comprueba que el usuario puede leerla). Devuelve la versión del servidor.
 */
export class MongoDbConnectionTester implements ConnectionTester {
  private client?: MongoClient;

  async ping(connectionString: string, dbName: string, timeoutMs: number): Promise<ConnectionPingResult> {
    if (!/^mongodb(\+srv)?:\/\/\S+$/.test(connectionString)) {
      throw new InvalidConnectionConfigError('URI de MongoDB inválida');
    }
    if (!dbName) throw new InvalidConnectionConfigError('Falta la base de datos de MongoDB');

    this.client = new MongoClient(connectionString, {
      appName: 'DataNexus',
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
      socketTimeoutMS: timeoutMs,
      maxPoolSize: 1,
      retryReads: false,
      retryWrites: false,
    });
    await this.client.connect();

    const db = this.client.db(dbName);
    await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
    const info = await db.command({ buildInfo: 1 }).catch(() => undefined);
    const version = typeof info?.version === 'string' ? info.version : undefined;
    return { serverVersion: version ? `MongoDB ${version}` : null };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    // force: no espera operaciones pendientes; sirve también cuando la prueba expiró.
    await client?.close(true).catch(() => undefined);
  }
}
