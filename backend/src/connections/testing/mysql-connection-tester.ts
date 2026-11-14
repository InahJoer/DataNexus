import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import {
  InvalidConnectionConfigError,
  type ConnectionPingResult,
  type ConnectionTester,
} from './connection-tester.interface.js';
import { mysqlSslOption } from '../credentials/tls-ca.js';

interface VersionRow extends RowDataPacket {
  version: string;
}

export class MysqlConnectionTester implements ConnectionTester {
  private connection?: Connection;

  async ping(connectionString: string, dbName: string, timeoutMs: number): Promise<ConnectionPingResult> {
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      throw new InvalidConnectionConfigError('Cadena MySQL inválida');
    }
    if (!['mysql:', 'mysql2:'].includes(url.protocol)) {
      throw new InvalidConnectionConfigError('Cadena MySQL inválida');
    }

    this.connection = await mysql.createConnection({
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: dbName,
      connectTimeout: timeoutMs,
      ssl: mysqlSslOption(url),
    });
    this.connection.on('error', () => undefined);

    const [rows] = await this.connection.query<VersionRow[]>({
      sql: 'SELECT VERSION() AS version',
      timeout: timeoutMs,
    });
    const version = rows[0]?.version;
    if (!version) return { serverVersion: null };
    return { serverVersion: /mariadb/i.test(version) ? `MariaDB ${version}` : `MySQL ${version}` };
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    // destroy() no espera al servidor: sirve también cuando la prueba expiró.
    connection?.destroy();
  }
}
