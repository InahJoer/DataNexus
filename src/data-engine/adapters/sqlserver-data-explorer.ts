import sql from 'mssql';
import type { ConnectionPool, Request } from 'mssql';
import type { CatalogObject, DataExplorer } from '../data-explorer.interface.js';

interface SqlServerCatalogRow {
  schema: string;
  name: string;
  type: 'BASE TABLE' | 'VIEW';
}

export class SqlServerDataExplorer implements DataExplorer {
  readonly tipoMotor = 'SQLServer';
  private pool?: ConnectionPool;
  private request?: Request;

  async listObjects(connectionString: string, dbName: string): Promise<CatalogObject[]> {
    const config = sql.ConnectionPool.parseConnectionString(connectionString);
    config.database = dbName;
    config.connectionTimeout = 8_000;
    config.requestTimeout = 8_000;
    config.pool = { ...config.pool, max: 1, min: 0 };

    this.pool = new sql.ConnectionPool(config);
    this.pool.on('error', () => undefined);
    await this.pool.connect();
    this.request = this.pool.request();
    const result = await this.request.query<SqlServerCatalogRow>(`
      SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name], TABLE_TYPE AS [type]
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);

    return result.recordset.map((row) => ({
      name: row.name,
      schema: row.schema,
      type: row.type === 'VIEW' ? 'VIEW' : 'TABLE',
    }));
  }

  async cancel(): Promise<void> {
    this.request?.cancel();
    this.request = undefined;
    const pool = this.pool;
    this.pool = undefined;
    if (pool) await pool.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    const pool = this.pool;
    if (!pool) return;
    await pool.close().catch(() => undefined);
    if (this.pool === pool) {
      this.pool = undefined;
      this.request = undefined;
    }
  }
}
