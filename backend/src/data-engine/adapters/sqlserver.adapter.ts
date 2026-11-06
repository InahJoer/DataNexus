import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import sql from 'mssql';
import type { ConnectionPool } from 'mssql';
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

interface SqlServerCatalogRow {
  schema: string;
  name: string;
  type: string;
}

const SOURCE_ALIAS = '[__dataNexusSource]';
const METRICS_ALIAS = '[__dataNexusMetrics]';

/** SQL Server: exploración y extracción con un ConnectionPool de mssql reutilizable por conexión. */
@Injectable()
export class SqlServerAdapter implements IDataSourceAdapter {
  readonly tipoMotor = 'SQLSERVER' as const;
  readonly capabilities = { explore: true, fields: true, extract: true };

  constructor(private readonly clients: DataSourceClientPool) {}

  listObjects(connection: DataSourceConnection): Promise<CatalogObject[]> {
    return this.withPool(connection, async (pool) => {
      const result = await pool.request().query<SqlServerCatalogRow>(`
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
    });
  }

  listFields(connection: DataSourceConnection, objectName: string, schema?: string): Promise<string[]> {
    return this.withPool(connection, async (pool) => {
      const result = await pool
        .request()
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
    });
  }

  async extract(connection: DataSourceConnection, tableName: string, options: ExtractOptions = {}): Promise<Record<string, any>[]> {
    const qualifiedTable = this.qualifyTable(tableName, options.schema);
    const maxRows = getMaxSourceRows();
    const maxBytes = getMaxSourceBytes();

    return await this.withPool(connection, async (pool) => {
      const columns = await this.listColumns(pool, qualifiedTable);
      if (columns.length === 0) {
        throw new BadRequestException('La tabla no existe o no tiene columnas visibles');
      }
      const query = this.buildLimitedSelect(qualifiedTable, columns, options.filters ?? [], maxRows, maxBytes);

      return new Promise<Record<string, any>[]>((resolve, reject) => {
        const request = pool.request();
        for (const [name, value] of Object.entries(query.parameters)) request.input(name, value);
        request.stream = true;
        const rows: Record<string, any>[] = [];
        let totalBytes = 0;
        let settled = false;

        const rejectOnce = (error: unknown, cancel = false) => {
          if (settled) return;
          settled = true;
          if (cancel) {
            try {
              request.cancel();
            } catch {
              // La consulta pudo terminar mientras se cancelaba.
            }
          }
          reject(error);
        };

        request.on('row', (row: Record<string, any>) => {
          if (settled) return;
          if (row[query.oversizedKey]) {
            rejectOnce(new PayloadTooLargeException(`Una fila de la fuente supera el máximo de ${maxBytes} bytes configurado`), true);
            return;
          }
          delete row[query.oversizedKey];
          if (rows.length >= maxRows) {
            rejectOnce(new PayloadTooLargeException(`La fuente supera el máximo de ${maxRows} filas configurado`), true);
            return;
          }
          let rowBytes: number;
          try {
            rowBytes = getJsonByteLength(row);
          } catch (error) {
            rejectOnce(error, true);
            return;
          }
          if (totalBytes + rowBytes > maxBytes) {
            rejectOnce(new PayloadTooLargeException(`La fuente supera el máximo de ${maxBytes} bytes configurado`), true);
            return;
          }
          totalBytes += rowBytes;
          rows.push(row);
        });
        request.on('error', (error: unknown) => rejectOnce(error));
        request.on('done', () => {
          if (settled) return;
          settled = true;
          resolve(rows);
        });

        try {
          void request.query(query.sql).catch((error: unknown) => rejectOnce(error));
        } catch (error) {
          rejectOnce(error);
        }
      });
    });
  }

  private withPool<R>(connection: DataSourceConnection, use: (pool: ConnectionPool) => Promise<R>): Promise<R> {
    return this.clients.withClient(
      { connectionId: connection.id, connectionString: connection.connectionString, variant: connection.dbName },
      async () => {
        const config = sql.ConnectionPool.parseConnectionString(connection.connectionString);
        config.database = connection.dbName;
        config.connectionTimeout = EXTERNAL_QUERY_TIMEOUT_MS;
        config.requestTimeout = EXTERNAL_QUERY_TIMEOUT_MS;
        config.pool = { ...config.pool, max: 4, min: 0, idleTimeoutMillis: 60_000 };
        const pool = new sql.ConnectionPool(config);
        pool.on('error', () => undefined);
        await pool.connect();
        return pool;
      },
      (pool) => pool.close(),
      use,
    );
  }

  private qualifyTable(tableName: string, schema?: string): string {
    const table = this.quoteIdentifier(tableName, 'tabla');
    return schema ? `${this.quoteIdentifier(schema, 'esquema')}.${table}` : table;
  }

  private async listColumns(pool: ConnectionPool, qualifiedTable: string): Promise<string[]> {
    const objectName = qualifiedTable.replace(/'/g, "''");
    const result = await pool
      .request()
      .query(
        `SELECT [name] AS [name] FROM [sys].[columns] WHERE [object_id] = OBJECT_ID(N'${objectName}') ORDER BY [column_id]`,
      );
    return result.recordset.map((column) => String(column.name));
  }

  private buildLimitedSelect(
    qualifiedTable: string,
    columns: string[],
    filters: ExtractOptions['filters'] & object,
    maxRows: number,
    maxBytes: number,
  ): { sql: string; oversizedKey: string; parameters: Record<string, unknown> } {
    const rowBytesAlias = `${METRICS_ALIAS}.[row_bytes]`;
    const rowBytesExpression = columns
      .map(
        (column) =>
          `COALESCE(CONVERT(bigint, DATALENGTH(${SOURCE_ALIAS}.${this.quoteIdentifier(column, 'columna')})), 0)`,
      )
      .join(' + ');
    // Margen para el escapado JSON y la serialización de escalares y binarios.
    const serializedStructureBytes = getJsonByteLength(Object.fromEntries(columns.map((column) => [column, null])));
    const estimatedJsonBytes = `(${rowBytesAlias} * 8) + ${serializedStructureBytes}`;
    const oversizedKey = uniqueColumnName(columns, '__dataNexusOversized');
    const projection = columns.map((column) => {
      const quotedColumn = this.quoteIdentifier(column, 'columna');
      return `CASE WHEN ${estimatedJsonBytes} > ${maxBytes} THEN NULL ELSE ${SOURCE_ALIAS}.${quotedColumn} END AS ${quotedColumn}`;
    });
    projection.push(
      `CASE WHEN ${estimatedJsonBytes} > ${maxBytes} THEN CONVERT(bit, 1) ELSE CONVERT(bit, 0) END AS ${this.quoteIdentifier(oversizedKey, 'columna')}`,
    );

    const parameters: Record<string, unknown> = {};
    let index = 0;
    const clauses = buildSqlFilterClauses(columns, filters, {
      column: (name) => `${SOURCE_ALIAS}.${this.quoteIdentifier(name, 'filtro')}`,
      parameter: (value) => {
        const name = `filter_${index++}`;
        parameters[name] = value;
        return `@${name}`;
      },
    });
    const whereClause = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

    return {
      sql: `SELECT TOP (${maxRows + 1}) ${projection.join(', ')} FROM ${qualifiedTable} AS ${SOURCE_ALIAS} CROSS APPLY (SELECT ${rowBytesExpression} AS [row_bytes]) AS ${METRICS_ALIAS}${whereClause}`,
      oversizedKey,
      parameters,
    };
  }

  private quoteIdentifier(value: string, description: string): string {
    if (!value || value.length > 128 || value.includes('\0')) {
      throw new BadRequestException(`El nombre de ${description} no es válido`);
    }
    return `[${value.replace(/]/g, ']]')}]`;
  }
}
