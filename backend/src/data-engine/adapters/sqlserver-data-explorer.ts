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
    const pool = await this.connect(connectionString, dbName);
    this.request = pool.request();
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

  async listFields(connectionString: string, dbName: string, objectName: string, schema?: string): Promise<string[]> {
    const pool = await this.connect(connectionString, dbName);
    this.request = pool.request();
    const result = await this.request
      .input('tableName', sql.NVarChar(128), objectName)
      .input('schemaName', sql.NVarChar(128), schema ?? null)
      .query<{ name: string }>(`
        SELECT COLUMN_NAME AS [name]
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @tableName
          AND (@schemaName IS NULL OR TABLE_SCHEMA = @schemaName)
        ORDER BY ORDINAL_POSITION
      `);

    return result.recordset.map((row) => row.name);
  }

  private async connect(connectionString: string, dbName: string): Promise<ConnectionPool> {
    if (this.pool?.connected) return this.pool;
    const config = sql.ConnectionPool.parseConnectionString(connectionString);
    config.database = dbName;
    config.connectionTimeout = 8_000;
    config.requestTimeout = 8_000;
    config.pool = { ...config.pool, max: 1, min: 0 };

    const pool = new sql.ConnectionPool(config);
    pool.on('error', () => undefined);
    this.pool = pool;
    await pool.connect();
    return pool;
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
