import { Injectable } from '@nestjs/common';
import { Pool, type QueryResultRow } from 'pg';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';
import { EXTERNAL_QUERY_TIMEOUT_MS } from '../data-engine.constants.js';
import {
  UnsupportedOperationError,
  type CatalogObject,
  type DataSourceConnection,
  type IDataSourceAdapter,
} from './data-source-adapter.interface.js';

interface PostgresCatalogRow {
  schema: string;
  name: string;
  type: string;
}

/** PostgreSQL: exploración de tablas, vistas y columnas con un pg.Pool reutilizable por conexión. */
@Injectable()
export class PostgresAdapter implements IDataSourceAdapter {
  readonly tipoMotor = 'POSTGRESQL' as const;
  readonly capabilities = { explore: true, fields: true, extract: false };

  constructor(private readonly clients: DataSourceClientPool) {}

  async listObjects(connection: DataSourceConnection): Promise<CatalogObject[]> {
    const result = await this.query<PostgresCatalogRow>(
      connection,
      `SELECT table_schema AS schema, table_name AS name, table_type AS type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY table_schema, table_name`,
    );
    return result.map((row) => ({ name: row.name, schema: row.schema, type: row.type === 'VIEW' ? 'VIEW' : 'TABLE' }));
  }

  async listFields(connection: DataSourceConnection, objectName: string, schema?: string): Promise<string[]> {
    const rows = await this.query<{ name: string }>(
      connection,
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_name = $1 AND ($2::text IS NULL OR table_schema = $2)
         AND table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, ordinal_position`,
      [objectName, schema ?? null],
    );
    return rows.map((row) => row.name);
  }

  extract(): Promise<Record<string, any>[]> {
    return Promise.reject(new UnsupportedOperationError('PostgreSQL aún no tiene extractor de datos'));
  }

  private query<T extends QueryResultRow>(connection: DataSourceConnection, text: string, values: unknown[] = []) {
    return this.clients.withClient(
      { connectionId: connection.id, connectionString: connection.connectionString, variant: connection.dbName },
      () => Promise.resolve(this.createPool(connection)),
      (pool) => pool.end(),
      async (pool) => (await pool.query<T>(text, values)).rows,
    );
  }

  /** Usa siempre el dbName del registro, aunque la URL traiga otra base. */
  private createPool(connection: DataSourceConnection): Pool {
    const url = new URL(connection.connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('Invalid PostgreSQL connection configuration');
    }
    url.pathname = `/${encodeURIComponent(connection.dbName)}`;
    const pool = new Pool({
      connectionString: url.toString(),
      max: 4,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: EXTERNAL_QUERY_TIMEOUT_MS,
      query_timeout: EXTERNAL_QUERY_TIMEOUT_MS,
      statement_timeout: EXTERNAL_QUERY_TIMEOUT_MS,
    });
    // Un error de un cliente inactivo no debe tumbar el proceso; el pool lo reemplaza.
    pool.on('error', () => undefined);
    return pool;
  }
}
