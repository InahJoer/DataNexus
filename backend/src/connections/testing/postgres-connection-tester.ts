import { Client } from 'pg';
import {
  InvalidConnectionConfigError,
  type ConnectionPingResult,
  type ConnectionTester,
} from './connection-tester.interface.js';

export class PostgresConnectionTester implements ConnectionTester {
  private client?: Client;

  async ping(connectionString: string, dbName: string, timeoutMs: number): Promise<ConnectionPingResult> {
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      throw new InvalidConnectionConfigError('Cadena PostgreSQL inválida');
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new InvalidConnectionConfigError('Cadena PostgreSQL inválida');
    }
    url.pathname = `/${encodeURIComponent(dbName)}`;

    this.client = new Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
    });
    this.client.on('error', () => undefined);
    await this.client.connect();
    const result = await this.client.query<{ server_version: string }>('SHOW server_version');
    const version = result.rows[0]?.server_version;
    return { serverVersion: version ? `PostgreSQL ${version}` : null };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.end().catch(() => undefined);
  }
}
