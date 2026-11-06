import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
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
  UpdateRecordInput,
  UpdateRecordResult,
} from './data-source-adapter.interface.js';
import { assertExactPrimaryKey, assertExpectedCellValue, decodeBase64CellValue, normalizeCellValue } from './cell-update.js';
import { buildSqlFilterClauses, uniqueColumnName } from './sql-filters.js';
import {
  NO_PRIMARY_KEY_MESSAGE,
  buildKeysetCondition,
  toDataPage,
  type DataPage,
  type DataPageOptions,
} from '../pagination/keyset.js';

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

  /** Página con keyset pagination sobre la llave primaria (RNF-06), sin OFFSET. */
  async readPage(connection: DataSourceConnection, tableName: string, options: DataPageOptions): Promise<DataPage> {
    quoteMysqlIdentifier(tableName, 'tabla');
    if (options.schema !== undefined) quoteMysqlIdentifier(options.schema, 'esquema');
    const columns = await this.listFields(connection, tableName, options.schema);
    if (columns.length === 0) throw new BadRequestException('La tabla no existe o no tiene columnas visibles');

    const keys = (
      await this.query<{ COLUMN_NAME: string }>(
        connection,
        `SELECT /*+ MAX_EXECUTION_TIME(${EXTERNAL_QUERY_TIMEOUT_MS}) */ COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
         ORDER BY ORDINAL_POSITION`,
        [options.schema ?? null, tableName],
      )
    ).map((row) => row.COLUMN_NAME);
    if (keys.length === 0) throw new BadRequestException(NO_PRIMARY_KEY_MESSAGE);

    const params: unknown[] = [];
    const parameter = (value: unknown) => {
      params.push(value);
      return '?';
    };
    const quote = (name: string) => `${SOURCE_ALIAS}.${quoteMysqlIdentifier(name, 'columna')}`;
    const where = buildSqlFilterClauses(columns, options.filters ?? [], {
      column: quote,
      text: (column) => `CAST(${column} AS CHAR)`,
      parameter,
    });
    if (options.after) where.push(buildKeysetCondition(keys.map(quote), options.after, parameter));
    const table = options.schema
      ? `${quoteMysqlIdentifier(options.schema, 'esquema')}.${quoteMysqlIdentifier(tableName, 'tabla')}`
      : quoteMysqlIdentifier(tableName, 'tabla');

    const sql =
      `SELECT /*+ MAX_EXECUTION_TIME(${EXTERNAL_QUERY_TIMEOUT_MS}) */ ${columns.map(quote).join(', ')} FROM ${table} AS ${SOURCE_ALIAS}` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY ${keys.map(quote).join(', ')} LIMIT ${options.pageSize + 1}`;
    const raw = await this.query<Record<string, unknown>>(connection, sql, params);
    return toDataPage(raw, keys, options.pageSize, (row) => this.normalizeRow(row, ''));
  }

  async updateRecord(connection: DataSourceConnection, input: UpdateRecordInput): Promise<UpdateRecordResult> {
    quoteMysqlIdentifier(input.entityName, 'tabla');
    if (input.schema !== undefined) quoteMysqlIdentifier(input.schema, 'esquema');
    quoteMysqlIdentifier(input.field, 'campo');
    const qualifiedTable = input.schema
      ? `${quoteMysqlIdentifier(input.schema, 'esquema')}.${quoteMysqlIdentifier(input.entityName, 'tabla')}`
      : quoteMysqlIdentifier(input.entityName, 'tabla');

    return await this.withPool(connection, async (pool) => {
      const pooled = await pool.getConnection();
      let healthy = true;
      let inTransaction = false;
      try {
        await pooled.beginTransaction();
        inTransaction = true;

        const [objects] = await pooled.query<RowDataPacket[]>(
          `SELECT TABLE_TYPE AS tableType, ENGINE AS engine FROM information_schema.tables
           WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`,
          [input.schema ?? null, input.entityName],
        );
        const object = objects[0] as { tableType?: string; engine?: string } | undefined;
        if (!object) throw new NotFoundException('La tabla no existe en la conexión');
        if (object.tableType !== 'BASE TABLE') throw new BadRequestException('Solo se pueden editar tablas base');
        if (object.engine?.toLowerCase() !== 'innodb') {
          throw new BadRequestException('La tabla debe usar InnoDB para garantizar la concurrencia optimista');
        }

        const [columnRows] = await pooled.query<RowDataPacket[]>(
          `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, EXTRA AS extra, GENERATION_EXPRESSION AS generationExpression
           FROM information_schema.columns
           WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`,
          [input.schema ?? null, input.entityName],
        );
        const column = (columnRows as unknown as Array<{ name: string; dataType: string; extra: string; generationExpression: string }>).find(
          (candidate) => candidate.name === input.field,
        );
        if (!column) throw new BadRequestException('El campo no existe en la tabla');
        if (/generated|auto_increment/i.test(column.extra ?? '') || Boolean(column.generationExpression)) {
          throw new BadRequestException('No se pueden editar campos generados');
        }

        const [keyRows] = await pooled.query<RowDataPacket[]>(
          `SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
           WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
           ORDER BY ORDINAL_POSITION`,
          [input.schema ?? null, input.entityName],
        );
        const primaryKey = (keyRows as unknown as Array<{ name: string }>).map((row) => row.name);
        if (primaryKey.length === 0) throw new BadRequestException(NO_PRIMARY_KEY_MESSAGE);
        if (primaryKey.includes(input.field)) throw new BadRequestException('No se puede editar una columna de llave primaria');
        const key = assertExactPrimaryKey(input.primaryKey, primaryKey);
        const keyClauses = primaryKey.map((name) => `${quoteMysqlIdentifier(name, 'llave primaria')} = ?`);
        const keyValues = primaryKey.map((name) => key[name]);

        const [selectedRows] = await pooled.query<RowDataPacket[]>(
          `SELECT ${quoteMysqlIdentifier(input.field, 'campo')} AS __dn_value FROM ${qualifiedTable}
           WHERE ${keyClauses.join(' AND ')} FOR UPDATE`,
          keyValues,
        );
        const selected = selectedRows[0] as { __dn_value?: unknown } | undefined;
        if (!selected) throw new NotFoundException('El registro no existe en la tabla');
        const valueBefore = assertExpectedCellValue(selected.__dn_value, input.expectedValue);
        if (Object.is(normalizeCellValue(selected.__dn_value), input.nextValue)) {
          await pooled.commit();
          inTransaction = false;
          return { valueBefore, valueAfter: valueBefore };
        }

        const binaryTypes = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit']);
        const isJson = column.dataType === 'json';
        const nextValue = binaryTypes.has(column.dataType)
          ? decodeBase64CellValue(input.nextValue)
          : isJson && input.nextValue !== null
            ? JSON.stringify(input.nextValue)
            : input.nextValue;
        await pooled.query(
          `UPDATE ${qualifiedTable} SET ${quoteMysqlIdentifier(input.field, 'campo')} = ? WHERE ${keyClauses.join(' AND ')}`,
          [nextValue, ...keyValues],
        );

        const [persistedRows] = await pooled.query<RowDataPacket[]>(
          `SELECT ${quoteMysqlIdentifier(input.field, 'campo')} AS __dn_value FROM ${qualifiedTable}
           WHERE ${keyClauses.join(' AND ')}`,
          keyValues,
        );
        if (!persistedRows[0]) throw new NotFoundException('El registro ya no existe en la tabla');
        const valueAfter = normalizeCellValue((persistedRows[0] as { __dn_value?: unknown }).__dn_value);

        await pooled.commit();
        inTransaction = false;
        return { valueBefore, valueAfter };
      } catch (error) {
        if (inTransaction) {
          try {
            await pooled.rollback();
          } catch {
            healthy = false;
          }
        }
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
