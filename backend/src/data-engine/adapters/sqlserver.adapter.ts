import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
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

  /** Página con keyset pagination sobre la llave primaria (RNF-06): TOP (n + 1) ... ORDER BY llave, sin OFFSET. */
  async readPage(connection: DataSourceConnection, tableName: string, options: DataPageOptions): Promise<DataPage> {
    const qualifiedTable = this.qualifyTable(tableName, options.schema);
    return await this.withPool(connection, async (pool) => {
      const columns = await this.listColumns(pool, qualifiedTable);
      if (columns.length === 0) throw new BadRequestException('La tabla no existe o no tiene columnas visibles');
      const objectName = qualifiedTable.replace(/'/g, "''");
      const keyResult = await pool.request().query<{ name: string }>(
        `SELECT c.[name] AS [name]
         FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.[object_id] = i.[object_id] AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.[object_id] = ic.[object_id] AND c.column_id = ic.column_id
         WHERE i.[object_id] = OBJECT_ID(N'${objectName}') AND i.is_primary_key = 1
         ORDER BY ic.key_ordinal`,
      );
      const keys = keyResult.recordset.map((row) => String(row.name));
      if (keys.length === 0) throw new BadRequestException(NO_PRIMARY_KEY_MESSAGE);

      const request = pool.request();
      let index = 0;
      const parameter = (value: unknown) => {
        const name = `p_${index++}`;
        request.input(name, value);
        return `@${name}`;
      };
      const quote = (name: string) => `${SOURCE_ALIAS}.${this.quoteIdentifier(name, 'columna')}`;
      const where = buildSqlFilterClauses(columns, options.filters ?? [], {
        column: quote,
        text: (column) => `CAST(${column} AS NVARCHAR(4000))`,
        parameter,
      });
      if (options.after) where.push(buildKeysetCondition(keys.map(quote), options.after, parameter));

      const result = await request.query<Record<string, unknown>>(
        `SELECT TOP (${options.pageSize + 1}) ${columns.map(quote).join(', ')} FROM ${qualifiedTable} AS ${SOURCE_ALIAS}` +
          (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
          ` ORDER BY ${keys.map(quote).join(', ')}`,
      );
      return toDataPage(result.recordset, keys, options.pageSize, (row) => {
        const normalized: Record<string, any> = {};
        for (const [key, value] of Object.entries(row)) {
          normalized[key] = Buffer.isBuffer(value) ? value.toString('base64') : value instanceof Date ? value.toISOString() : value;
        }
        return normalized;
      });
    });
  }

  async updateRecord(connection: DataSourceConnection, input: UpdateRecordInput): Promise<UpdateRecordResult> {
    const qualifiedTable = this.qualifyTable(input.entityName, input.schema);

    return await this.withPool(connection, async (pool) => {
      const transaction = new sql.Transaction(pool);
      let inTransaction = false;
      try {
        await transaction.begin();
        inTransaction = true;

        const objectResult = await new sql.Request(transaction)
          .input('objectName', sql.NVarChar(260), qualifiedTable)
          .query<{ type: string }>(`SELECT [type] FROM sys.objects WHERE [object_id] = OBJECT_ID(@objectName) AND [type] IN ('U', 'V')`);
        const objectType = objectResult.recordset[0]?.type;
        if (!objectType) throw new NotFoundException('La tabla no existe en la conexión');
        if (objectType !== 'U') throw new BadRequestException('Solo se pueden editar tablas base');

        const columnResult = await new sql.Request(transaction)
          .input('objectName', sql.NVarChar(260), qualifiedTable)
          .query<{ name: string; typeName: string; isIdentity: boolean; isComputed: boolean; generatedAlwaysType: number }>(`
            SELECT c.[name], TYPE_NAME(c.system_type_id) AS [typeName],
                   c.is_identity AS [isIdentity], c.is_computed AS [isComputed],
                   c.generated_always_type AS [generatedAlwaysType]
            FROM sys.columns c WHERE c.[object_id] = OBJECT_ID(@objectName)
          `);
        const column = columnResult.recordset.find((candidate) => candidate.name === input.field);
        if (!column) throw new BadRequestException('El campo no existe en la tabla');
        if (column.isIdentity || column.isComputed || column.generatedAlwaysType !== 0 || column.typeName === 'timestamp') {
          throw new BadRequestException('No se pueden editar campos generados');
        }

        const keyResult = await new sql.Request(transaction)
          .input('objectName', sql.NVarChar(260), qualifiedTable)
          .query<{ name: string }>(`
            SELECT c.[name] AS [name]
            FROM sys.indexes i
            JOIN sys.index_columns ic ON ic.[object_id] = i.[object_id] AND ic.index_id = i.index_id
            JOIN sys.columns c ON c.[object_id] = ic.[object_id] AND c.column_id = ic.column_id
            WHERE i.[object_id] = OBJECT_ID(@objectName) AND i.is_primary_key = 1
            ORDER BY ic.key_ordinal
          `);
        const primaryKey = keyResult.recordset.map((row) => String(row.name));
        if (primaryKey.length === 0) throw new BadRequestException(NO_PRIMARY_KEY_MESSAGE);
        if (primaryKey.includes(input.field)) throw new BadRequestException('No se puede editar una columna de llave primaria');
        const key = assertExactPrimaryKey(input.primaryKey, primaryKey);

        const request = new sql.Request(transaction);
        const clauses = primaryKey.map((name, index) => {
          const parameter = `key_${index}`;
          request.input(parameter, key[name]);
          return `${this.quoteIdentifier(name, 'llave primaria')} = @${parameter}`;
        });
        const selected = await request.query<Record<string, unknown>>(
          `SELECT ${this.quoteIdentifier(input.field, 'campo')} AS [__dn_value]
           FROM ${qualifiedTable} WITH (UPDLOCK, ROWLOCK, HOLDLOCK) WHERE ${clauses.join(' AND ')}`,
        );
        const row = selected.recordset[0];
        if (!row) throw new NotFoundException('El registro no existe en la tabla');
        const valueBefore = assertExpectedCellValue(row.__dn_value, input.expectedValue);

        const binaryTypes = new Set(['binary', 'varbinary', 'image']);
        const nextValue = binaryTypes.has(column.typeName)
          ? decodeBase64CellValue(input.nextValue)
          : input.nextValue;
        const updateRequest = new sql.Request(transaction).input('nextValue', nextValue);
        const updateClauses = primaryKey.map((name, index) => {
          const parameter = `update_key_${index}`;
          updateRequest.input(parameter, key[name]);
          return `${this.quoteIdentifier(name, 'llave primaria')} = @${parameter}`;
        });
        await updateRequest.query(
          `UPDATE ${qualifiedTable} SET ${this.quoteIdentifier(input.field, 'campo')} = @nextValue WHERE ${updateClauses.join(' AND ')}`,
        );

        const persistedRequest = new sql.Request(transaction);
        const persistedClauses = primaryKey.map((name, index) => {
          const parameter = `persisted_key_${index}`;
          persistedRequest.input(parameter, key[name]);
          return `${this.quoteIdentifier(name, 'llave primaria')} = @${parameter}`;
        });
        const persisted = await persistedRequest.query<Record<string, unknown>>(
          `SELECT ${this.quoteIdentifier(input.field, 'campo')} AS [__dn_value] FROM ${qualifiedTable}
           WHERE ${persistedClauses.join(' AND ')}`,
        );
        if (!persisted.recordset[0]) throw new NotFoundException('El registro ya no existe en la tabla');
        const valueAfter = normalizeCellValue(persisted.recordset[0].__dn_value);

        await transaction.commit();
        inTransaction = false;
        return { valueBefore, valueAfter };
      } catch (error) {
        if (inTransaction) {
          try {
            await transaction.rollback();
          } catch {
            // Preserve the source or domain error that caused the rollback.
          }
        }
        throw error;
      }
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
      text: (column) => `CAST(${column} AS NVARCHAR(4000))`,
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
