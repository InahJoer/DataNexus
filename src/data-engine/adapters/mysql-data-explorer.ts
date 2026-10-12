import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { CatalogObject, DataExplorer } from '../data-explorer.interface.js';

interface MysqlCatalogRow extends RowDataPacket {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_TYPE: 'BASE TABLE' | 'VIEW';
}

export class MysqlDataExplorer implements DataExplorer {
  readonly tipoMotor = 'MySQL';
  private connection?: Connection;

  async listObjects(connectionString: string, dbName: string): Promise<CatalogObject[]> {
    const url = new URL(connectionString);
    if (!['mysql:', 'mysql2:'].includes(url.protocol)) {
      throw new Error('Invalid MySQL connection configuration');
    }

    this.connection = await mysql.createConnection({
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: dbName,
      connectTimeout: 8_000,
      ssl: url.searchParams.get('ssl') === 'true' ? {} : undefined,
    });

    const [rows] = await this.connection.query<MysqlCatalogRow[]>(
      `SELECT /*+ MAX_EXECUTION_TIME(8000) */ TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
       FROM information_schema.tables
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );

    return rows.map((row) => ({
      name: row.TABLE_NAME,
      schema: row.TABLE_SCHEMA,
      type: row.TABLE_TYPE === 'VIEW' ? 'VIEW' : 'TABLE',
    }));
  }

  async cancel(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    connection?.destroy();
  }

  async close(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    await connection.end().catch(() => undefined);
    if (this.connection === connection) this.connection = undefined;
  }
}
