import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { Pool, Query, type PoolClient, type QueryResultRow } from 'pg';
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

const MAX_IDENTIFIER_LENGTH = 63;
const SOURCE_ALIAS = '"__dn_src"';
const ROWS_ALIAS = '"__dn_rows"';

interface PostgresCatalogRow {
  schema: string;
  name: string;
  type: string;
}

export interface PostgresSelect {
  text: string;
  values: Array<string | number | boolean>;
  oversizedKey: string;
}

/** Escapa un identificador de PostgreSQL con comillas dobles ("a""b"). Rechaza nombres vacíos, largos o con NUL. */
export function quotePostgresIdentifier(value: string, description: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_IDENTIFIER_LENGTH || value.includes('\0')) {
    throw new BadRequestException(`El nombre de ${description} no es válido`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * SELECT limitado para extraer una tabla de PostgreSQL, con las mismas garantías que el extractor de MySQL:
 * - Solo columnas reales (information_schema) y escapadas.
 * - Filtros como parámetros $1, $2... (filter pushdown); los valores nunca se concatenan al SQL.
 * - LIMIT maxRows + 1 para detectar que la fuente supera el máximo sin leerla entera.
 * - El tamaño de cada fila se estima en el servidor: si supera maxBytes, sus columnas vuelven en NULL y la fila
 *   se marca para rechazarla sin transferir su contenido.
 * El tiempo máximo lo corta statement_timeout, configurado en el pool.
 */
export function buildPostgresSelect(
  table: string,
  schema: string,
  columns: readonly string[],
  filters: ExtractOptions['filters'],
  maxRows: number,
  maxBytes: number,
): PostgresSelect {
  const qualifiedTable = `${quotePostgresIdentifier(schema, 'esquema')}.${quotePostgresIdentifier(table, 'tabla')}`;
  const quoted = columns.map((column) => quotePostgresIdentifier(column, 'columna'));
  const bytesKey = quotePostgresIdentifier(uniqueColumnName(columns, '__dn_row_bytes'), 'columna');
  const oversizedKey = uniqueColumnName([...columns, '__dn_row_bytes'], '__dn_oversized');

  const values: Array<string | number | boolean> = [];
  const where = buildSqlFilterClauses(columns, filters ?? [], {
    column: (name) => `${SOURCE_ALIAS}.${quotePostgresIdentifier(name, 'filtro')}`,
    parameter: (value) => {
      values.push(value);
      return `$${values.length}`;
    },
  });

  const rowBytes = quoted
    .map((column) => `COALESCE(octet_length(${SOURCE_ALIAS}.${column}::text), 0)`)
    .join(' + ');
  const structureBytes = getJsonByteLength(Object.fromEntries(columns.map((column) => [column, null])));
  const oversized = `((${ROWS_ALIAS}.${bytesKey} * 2) + ${structureBytes}) > ${maxBytes}`;

  const inner =
    `SELECT ${quoted.map((column) => `${SOURCE_ALIAS}.${column}`).join(', ')}, (${rowBytes})::bigint AS ${bytesKey} ` +
    `FROM ${qualifiedTable} AS ${SOURCE_ALIAS}` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '');
  const projection = [
    ...quoted.map((column) => `CASE WHEN ${oversized} THEN NULL ELSE ${ROWS_ALIAS}.${column} END AS ${column}`),
    `(${oversized}) AS ${quotePostgresIdentifier(oversizedKey, 'columna')}`,
  ];

  return {
    text: `SELECT ${projection.join(', ')} FROM (${inner}) AS ${ROWS_ALIAS} LIMIT ${maxRows + 1}`,
    values,
    oversizedKey,
  };
}

/** PostgreSQL: exploración y extracción de tablas y vistas con un pg.Pool reutilizable por conexión. */
@Injectable()
export class PostgresAdapter implements IDataSourceAdapter {
  readonly tipoMotor = 'POSTGRESQL' as const;
  readonly capabilities = { explore: true, fields: true, extract: true };

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

  async extract(
    connection: DataSourceConnection,
    tableName: string,
    options: ExtractOptions = {},
  ): Promise<Record<string, any>[]> {
    quotePostgresIdentifier(tableName, 'tabla');
    if (options.schema !== undefined) quotePostgresIdentifier(options.schema, 'esquema');

    const schema = options.schema ?? (await this.resolveSchema(connection, tableName));
    const columns = schema ? await this.listFields(connection, tableName, schema) : [];
    if (!schema || columns.length === 0) {
      throw new BadRequestException('La tabla no existe o no tiene columnas visibles');
    }

    const maxRows = getMaxSourceRows();
    const maxBytes = getMaxSourceBytes();
    const select = buildPostgresSelect(tableName, schema, columns, options.filters, maxRows, maxBytes);

    return this.withPool(connection, async (pool) => {
      const client = await pool.connect();
      let healthy = true;
      try {
        return await this.streamRows(client, select, maxRows, maxBytes);
      } catch (error) {
        // La consulta pudo quedar a medias: se descarta el cliente en lugar de devolverlo al pool.
        healthy = false;
        throw error;
      } finally {
        client.release(!healthy);
      }
    });
  }

  /**
   * Esquema de una tabla indicada sin esquema: `public` si existe ahí; si no, el primero en orden alfabético.
   * Evita mezclar columnas de tablas homónimas de esquemas distintos.
   */
  private async resolveSchema(connection: DataSourceConnection, tableName: string): Promise<string | undefined> {
    const rows = await this.query<{ schema: string }>(
      connection,
      `SELECT table_schema AS schema
       FROM information_schema.tables
       WHERE table_name = $1 AND table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY (table_schema = 'public') DESC, table_schema
       LIMIT 1`,
      [tableName],
    );
    return rows[0]?.schema;
  }

  /** Lee fila a fila y corta en cuanto se supera un límite, sin esperar a que llegue todo el resultado. */
  private streamRows(
    client: PoolClient,
    select: PostgresSelect,
    maxRows: number,
    maxBytes: number,
  ): Promise<Record<string, any>[]> {
    return new Promise((resolve, reject) => {
      const rows: Record<string, any>[] = [];
      let totalBytes = 0;
      let failed = false;
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        reject(error);
      };

      const query = client.query(new Query({ text: select.text, values: select.values }));
      query.on('row', (raw: Record<string, unknown>) => {
        if (failed) return;
        if (raw[select.oversizedKey] === true) {
          return fail(new PayloadTooLargeException(`Una fila de la fuente supera el máximo de ${maxBytes} bytes configurado`));
        }
        if (rows.length >= maxRows) {
          return fail(new PayloadTooLargeException(`La fuente supera el máximo de ${maxRows} filas configurado`));
        }
        const row = this.normalizeRow(raw, select.oversizedKey);
        const rowBytes = getJsonByteLength(row);
        if (totalBytes + rowBytes > maxBytes) {
          return fail(new PayloadTooLargeException(`La fuente supera el máximo de ${maxBytes} bytes configurado`));
        }
        totalBytes += rowBytes;
        rows.push(row);
      });
      query.on('error', (error: Error) => fail(error));
      query.on('end', () => {
        if (!failed) resolve(rows);
      });
    });
  }

  /** Quita la columna auxiliar, pasa binarios a base64 y fechas a ISO 8601. */
  private normalizeRow(raw: Record<string, unknown>, oversizedKey: string): Record<string, any> {
    const row: Record<string, any> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === oversizedKey) continue;
      if (Buffer.isBuffer(value)) row[key] = value.toString('base64');
      else if (value instanceof Date) row[key] = Number.isNaN(value.getTime()) ? null : value.toISOString();
      else row[key] = value;
    }
    return row;
  }

  private query<T extends QueryResultRow>(connection: DataSourceConnection, text: string, values: unknown[] = []) {
    return this.withPool(connection, async (pool) => (await pool.query<T>(text, values)).rows);
  }

  private withPool<R>(connection: DataSourceConnection, use: (pool: Pool) => Promise<R>): Promise<R> {
    return this.clients.withClient(
      { connectionId: connection.id, connectionString: connection.connectionString, variant: connection.dbName },
      () => Promise.resolve(this.createPool(connection)),
      (pool) => pool.end(),
      use,
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
