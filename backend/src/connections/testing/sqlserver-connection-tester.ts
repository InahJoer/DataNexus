import sql from 'mssql';
import type { ConnectionPool } from 'mssql';
import {
  InvalidConnectionConfigError,
  type ConnectionPingResult,
  type ConnectionTester,
} from './connection-tester.interface.js';

interface VersionRow {
  version: string | null;
  edition: string | null;
}

export class SqlServerConnectionTester implements ConnectionTester {
  private pool?: ConnectionPool;

  async ping(connectionString: string, dbName: string, timeoutMs: number): Promise<ConnectionPingResult> {
    let config: sql.config;
    try {
      config = sql.ConnectionPool.parseConnectionString(connectionString);
    } catch {
      throw new InvalidConnectionConfigError('Cadena SQL Server inválida');
    }
    if (!config.server) throw new InvalidConnectionConfigError('Cadena SQL Server inválida');

    config.database = dbName;
    config.connectionTimeout = timeoutMs;
    config.requestTimeout = timeoutMs;
    config.pool = { ...config.pool, max: 1, min: 0 };

    const pool = new sql.ConnectionPool(config);
    pool.on('error', () => undefined);
    this.pool = pool;
    await pool.connect();

    const result = await pool.request().query<VersionRow>(`
      SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)) AS [version],
             CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)) AS [edition]
    `);
    const row = result.recordset[0];
    if (!row?.version) return { serverVersion: null };
    return {
      serverVersion: row.edition
        ? `SQL Server ${row.version} (${row.edition})`
        : `SQL Server ${row.version}`,
    };
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (pool) await pool.close().catch(() => undefined);
  }
}
