import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Connection as CoreConnection } from 'mysql2';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';
import {
  EXTERNAL_QUERY_TIMEOUT_MS,
  getJsonByteLength,
  getMaxSourceBytes,
  getMaxSourceRows,
} from '../data-engine.constants.js';
import type {
  CatalogObject,
  DataSourceConnection,
  ExtractOptions,
  IDataSourceAdapter,
} from './data-source-adapter.interface.js';
import { buildSqlFilterClauses, uniqueColumnName } from './sql-filters.js';

const MAX_IDENTIFIER_LENGTH = 64;
const SOURCE_ALIAS = '`__dn_src`';
const ROWS_ALIAS = '`__dn_rows`';

export interface MysqlSelect {
  sql: string;
  params: Array<string | number | boolean>;
  oversizedKey: string;
}

/** Escapa un identificador de MySQL con comillas invertidas (`a``b`). Rechaza nombres vacíos, largos o con NUL. */
export function quoteMysqlIdentifier(value: string, description: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_IDENTIFIER_LENGTH || value.includes('\0')) {
    throw new BadRequestException(`El nombre de ${description} no es válido`);
  }
  return `\`${value.replace(/`/g, '``')}\``;
}

/**
 * SELECT limitado para extraer una tabla de MySQL (issue #28):
 * - Solo columnas reales de la tabla (consultadas en information_schema) y escapadas.
 * - Filtros traducidos a WHERE con parámetros `?` (filter pushdown); los valores nunca se concatenan.
 * - LIMIT maxRows + 1 para detectar que la fuente supera el máximo sin leerla entera.
 * - El tamaño de cada fila se estima en el servidor: si una fila supera maxBytes, sus columnas vuelven en NULL
 *   y se marca para rechazarla sin transferir su contenido.
 * - MAX_EXECUTION_TIME corta en el servidor las consultas que tarden más que el límite externo.
 */
export function buildMysqlSelect(
  table: string,
  schema: string | undefined,
  columns: readonly string[],
  filters: ExtractOptions['filters'],
  maxRows: number,
  maxBytes: number,
): MysqlSelect {
  const qualifiedTable = schema
    ? `${quoteMysqlIdentifier(schema, 'esquema')}.${quoteMysqlIdentifier(table, 'tabla')}`
    : quoteMysqlIdentifier(table, 'tabla');
  const quoted = columns.map((column) => quoteMysqlIdentifier(column, 'columna'));
  const bytesKey = quoteMysqlIdentifier(uniqueColumnName(columns, '__dn_row_bytes'), 'columna');
  const oversizedKey = uniqueColumnName([...columns, '__dn_row_bytes'], '__dn_oversized');

  const params: Array<string | number | boolean> = [];
  const where = buildSqlFilterClauses(columns, filters ?? [], {
    column: (name) => `${SOURCE_ALIAS}.${quoteMysqlIdentifier(name, 'filtro')}`,
    text: (column) => `CAST(${column} AS CHAR)`,
    parameter: (value) => {
      params.push(value);
      return '?';
    },
  });

  const rowBytes = quoted.map((column) => `COALESCE(OCTET_LENGTH(${SOURCE_ALIAS}.${column}), 0)`).join(' + ');
  // Margen para el escapado JSON y la serialización de números, fechas y binarios.
  const structureBytes = getJsonByteLength(Object.fromEntries(columns.map((column) => [column, null])));
  const oversized = `((${ROWS_ALIAS}.${bytesKey} * 8) + ${structureBytes}) > ${maxBytes}`;

  const inner =
    `SELECT ${quoted.map((column) => `${SOURCE_ALIAS}.${column}`).join(', ')}, (${rowBytes}) AS ${bytesKey} ` +
    `FROM ${qualifiedTable} AS ${SOURCE_ALIAS}` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '');
  const projection = [
    ...quoted.map((column) => `CASE WHEN ${oversized} THEN NULL ELSE ${ROWS_ALIAS}.${column} END AS ${column}`),
    `CASE WHEN ${oversized} THEN 1 ELSE 0 END AS ${quoteMysqlIdentifier(oversizedKey, 'columna')}`,
  ];

  return {
    sql:
      `SELECT /*+ MAX_EXECUTION_TIME(${EXTERNAL_QUERY_TIMEOUT_MS}) */ ${projection.join(', ')} ` +
      `FROM (${inner}) AS ${ROWS_ALIAS} LIMIT ${maxRows + 1}`,
    params,
    oversizedKey,
  };
}

/** MySQL / MariaDB: exploración y extracción con un pool de mysql2 reutilizable por conexión. */
@Injectable()
export class MysqlAdapter implements IDataSourceAdapter {
  readonly tipoMotor = 'MYSQL' as const;
  readonly capabilities = { explore: true, fields: true, extract: true };

  constructor(private readonly clients: DataSourceClientPool) {}

  async listObjects(connection: DataSourceConnection): Promise<CatalogObject[]> {
    const rows = await this.query<{ TABLE_SCHEMA: string; TABLE_NAME: string; TABLE_TYPE: string }>(
      connection,
      `SELECT /*+ MAX_EXECUTION_TIME(${EXTERNAL_QUERY_TIMEOUT_MS}) */ TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
       FROM information_schema.tables
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    return rows.map((row) => ({
      name: row.TABLE_NAME,
      schema: row.TABLE_SCHEMA,
      type: row.TABLE_TYPE === 'VIEW' ? 'VIEW' : 'TABLE',
    }));
  }

  async listFields(connection: DataSourceConnection, objectName: string, schema?: string): Promise<string[]> {
    const rows = await this.query<{ COLUMN_NAME: string }>(
      connection,
      `SELECT /*+ MAX_EXECUTION_TIME(${EXTERNAL_QUERY_TIMEOUT_MS}) */ COLUMN_NAME
       FROM information_schema.columns
       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [schema ?? null, objectName],
    );
    return rows.map((row) => row.COLUMN_NAME);
  }

  async extract(
    connection: DataSourceConnection,
    tableName: string,
    options: ExtractOptions = {},
  ): Promise<Record<string, any>[]> {
    quoteMysqlIdentifier(tableName, 'tabla');
    if (options.schema !== undefined) quoteMysqlIdentifier(options.schema, 'esquema');

    const columns = await this.listFields(connection, tableName, options.schema);
    if (columns.length === 0) {
      throw new BadRequestException('La tabla no existe o no tiene columnas visibles');
    }

    const maxRows = getMaxSourceRows();
    const maxBytes = getMaxSourceBytes();
    const select = buildMysqlSelect(tableName, options.schema, columns, options.filters, maxRows, maxBytes);

    return this.withPool(connection, async (pool) => {
      const pooled = await pool.getConnection();
      let healthy = true;
      try {
        return await this.streamRows(pooled, select, maxRows, maxBytes);
      } catch (error) {
        // La consulta pudo quedar a medias: se descarta la conexión en lugar de devolverla al pool.
        healthy = false;
        throw error;
      } finally {
        if (healthy) pooled.release();
        else pooled.destroy();
      }
    });
  }

  private async streamRows(
    pooled: PoolConnection,
    select: MysqlSelect,
    maxRows: number,
    maxBytes: number,
  ): Promise<Record<string, any>[]> {
    // En tiempo de ejecución `connection` es la conexión base (callback) de mysql2, que sí permite stream();
    // los tipos de mysql2/promise la declaran como la versión con promesas.
    const core = pooled.connection as unknown as CoreConnection;
    const stream = core.query(select.sql, select.params).stream({ objectMode: true });
    const timeout = setTimeout(
      () => stream.destroy(Object.assign(new Error('MySQL query timeout'), { code: 'ETIMEDOUT' })),
      EXTERNAL_QUERY_TIMEOUT_MS,
    );
    timeout.unref?.();

    const rows: Record<string, any>[] = [];
    let totalBytes = 0;
    try {
      for await (const raw of stream as AsyncIterable<Record<string, unknown>>) {
        if (Number(raw[select.oversizedKey]) === 1) {
          throw new PayloadTooLargeException(`Una fila de la fuente supera el máximo de ${maxBytes} bytes configurado`);
        }
        if (rows.length >= maxRows) {
          throw new PayloadTooLargeException(`La fuente supera el máximo de ${maxRows} filas configurado`);
        }
        const row = this.normalizeRow(raw, select.oversizedKey);
        const rowBytes = getJsonByteLength(row);
        if (totalBytes + rowBytes > maxBytes) {
          throw new PayloadTooLargeException(`La fuente supera el máximo de ${maxBytes} bytes configurado`);
        }
        totalBytes += rowBytes;
        rows.push(row);
      }
      return rows;
    } finally {
      clearTimeout(timeout);
      stream.destroy();
    }
  }

  /** Quita la columna auxiliar y pasa los binarios a base64 para que el JSON sea legible y acotado. */
  private normalizeRow(raw: Record<string, unknown>, oversizedKey: string): Record<string, any> {
    const row: Record<string, any> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === oversizedKey) continue;
      row[key] = Buffer.isBuffer(value) ? value.toString('base64') : value;
    }
    return row;
  }

  private query<T>(connection: DataSourceConnection, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.withPool(connection, async (pool) => {
      const [rows] = await pool.query<RowDataPacket[]>(sql, params);
      return rows as T[];
    });
  }

  private withPool<R>(connection: DataSourceConnection, use: (pool: Pool) => Promise<R>): Promise<R> {
    return this.clients.withClient(
      { connectionId: connection.id, connectionString: connection.connectionString, variant: connection.dbName },
      async () => this.createPool(connection),
      (pool) => pool.end(),
      use,
    );
  }

  private createPool(connection: DataSourceConnection): Pool {
    const url = new URL(connection.connectionString);
    if (!['mysql:', 'mysql2:'].includes(url.protocol)) {
      throw new Error('Invalid MySQL connection configuration');
    }
    const pool = mysql.createPool({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: connection.dbName,
      ssl: url.searchParams.get('ssl') === 'true' ? {} : undefined,
      connectTimeout: EXTERNAL_QUERY_TIMEOUT_MS,
      connectionLimit: 4,
      maxIdle: 2,
      idleTimeout: 60_000,
      waitForConnections: true,
      queueLimit: 20,
      // Números exactos: BIGINT como texto; DECIMAL como número para poder agregarlos (SUM/AVG).
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: true,
      multipleStatements: false,
    });
    // Un error de una conexión inactiva no debe tumbar el proceso.
    pool.on('connection', (conn) => conn.on('error', () => undefined));
    return pool;
  }
}
