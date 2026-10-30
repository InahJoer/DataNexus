import { Client } from 'pg';
import type { CatalogObject, DataExplorer } from '../data-explorer.interface.js';

interface PostgresCatalogRow {
  schema: string;
  name: string;
  type: 'BASE TABLE' | 'VIEW';
}

export class PostgresDataExplorer implements DataExplorer {
  readonly tipoMotor = 'PostgreSQL';
  private client?: Client;

  async listObjects(connectionString: string, dbName: string): Promise<CatalogObject[]> {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('Invalid PostgreSQL connection configuration');
    }
    url.pathname = `/${encodeURIComponent(dbName)}`;

    this.client = new Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: 8_000,
      query_timeout: 8_000,
      statement_timeout: 8_000,
    });
    await this.client.connect();
    const result = await this.client.query<PostgresCatalogRow>(`
      SELECT table_schema AS schema, table_name AS name, table_type AS type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_schema, table_name
    `);

    return result.rows.map((row) => ({
      name: row.name,
      schema: row.schema,
      type: row.type === 'VIEW' ? 'VIEW' : 'TABLE',
    }));
  }

  async cancel(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.end().catch(() => undefined);
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    await client.end().catch(() => undefined);
    if (this.client === client) this.client = undefined;
  }
}
