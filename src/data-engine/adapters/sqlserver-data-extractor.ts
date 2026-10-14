import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sql from 'mssql';
import type { ConnectionPool } from 'mssql';
import type { EncryptionService } from '../../common/encryption/encryption.service.js';
import type {
  DataExtractorAdapter,
  DataExtractorOptions,
  EncryptedConnectionInfo,
} from './data-extractor.adapter.js';
import {
  EXTERNAL_QUERY_TIMEOUT_MS,
  getJsonByteLength,
  getMaxSourceBytes,
  getMaxSourceRows,
} from '../data-engine.constants.js';

export class SqlServerDataExtractor implements DataExtractorAdapter {
  private readonly maxRows: number;

  constructor(
    private readonly encryptionService: EncryptionService,
    maxRows = getMaxSourceRows(),
    private readonly maxBytes = getMaxSourceBytes(),
  ) {
    this.maxRows = maxRows;
  }

  async extract(
    connection: EncryptedConnectionInfo,
    tableName: string,
    options: DataExtractorOptions = {},
  ): Promise<Record<string, any>[]> {
    const qualifiedTable = this.qualifyTable(tableName, options.schema);

    const decryptedConnectionString = this.encryptionService.decrypt(
      connection.encryptedConnectionString,
    );
    const config = sql.ConnectionPool.parseConnectionString(
      decryptedConnectionString,
    );
    config.database = connection.dbName;
    config.connectionTimeout = EXTERNAL_QUERY_TIMEOUT_MS;
    config.requestTimeout = EXTERNAL_QUERY_TIMEOUT_MS;
    config.pool = { ...config.pool, max: 1, min: 0 };

    const pool = new sql.ConnectionPool(config);
    pool.on('error', () => undefined);

    try {
      await pool.connect();
      const columns = await this.listColumns(pool, qualifiedTable);
      if (columns.length === 0) {
        throw new BadRequestException(
          'La tabla no existe o no tiene columnas visibles',
        );
      }
      const query = this.buildLimitedSelect(qualifiedTable, columns);

      return await new Promise<Record<string, any>[]>((resolve, reject) => {
        const request = pool.request();
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
              // The request may already have completed while cancellation ran.
            }
          }
          reject(error);
        };

        request.on('row', (row: Record<string, any>) => {
          if (row[query.oversizedKey]) {
            rejectOnce(
              new PayloadTooLargeException(
                `Una fila de la fuente supera el máximo de ${this.maxBytes} bytes configurado`,
              ),
              true,
            );
            return;
          }
          delete row[query.oversizedKey];

          if (rows.length >= this.maxRows) {
            rejectOnce(
              new PayloadTooLargeException(
                `La fuente supera el máximo de ${this.maxRows} filas configurado`,
              ),
              true,
            );
            return;
          }

          let rowBytes: number;
          try {
            rowBytes = getJsonByteLength(row);
          } catch (error) {
            rejectOnce(error, true);
            return;
          }
          if (totalBytes + rowBytes > this.maxBytes) {
            rejectOnce(
              new PayloadTooLargeException(
                `La fuente supera el máximo de ${this.maxBytes} bytes configurado`,
              ),
              true,
            );
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
          void request
            .query(query.sql)
            .catch((error: unknown) => rejectOnce(error));
        } catch (error) {
          rejectOnce(error);
        }
      });
    } finally {
      await pool.close().catch(() => undefined);
    }
  }

  private qualifyTable(tableName: string, schema?: string): string {
    const table = this.quoteIdentifier(tableName, 'tabla');
    return schema
      ? `${this.quoteIdentifier(schema, 'esquema')}.${table}`
      : table;
  }

  private async listColumns(
    pool: ConnectionPool,
    qualifiedTable: string,
  ): Promise<string[]> {
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
  ): { sql: string; oversizedKey: string } {
    const sourceAlias = '[__dataNexusSource]';
    const metricsAlias = '[__dataNexusMetrics]';
    const rowBytesAlias = `${metricsAlias}.[row_bytes]`;
    const rowBytesExpression = columns
      .map(
        (column) =>
          `COALESCE(CONVERT(bigint, DATALENGTH(${sourceAlias}.${this.quoteIdentifier(column, 'columna')})), 0)`,
      )
      .join(' + ');
    // Allow for JSON escaping and JS string, scalar, and binary serialization expansion.
    const serializedStructureBytes = getJsonByteLength(
      Object.fromEntries(columns.map((column) => [column, null])),
    );
    const estimatedJsonBytes = `(${rowBytesAlias} * 8) + ${serializedStructureBytes}`;
    const oversizedKey = this.uniqueColumnName(columns, '__dataNexusOversized');
    const projection = columns.map((column) => {
      const quotedColumn = this.quoteIdentifier(column, 'columna');
      return `CASE WHEN ${estimatedJsonBytes} > ${this.maxBytes} THEN NULL ELSE ${sourceAlias}.${quotedColumn} END AS ${quotedColumn}`;
    });
    projection.push(
      `CASE WHEN ${estimatedJsonBytes} > ${this.maxBytes} THEN CONVERT(bit, 1) ELSE CONVERT(bit, 0) END AS ${this.quoteIdentifier(oversizedKey, 'columna')}`,
    );

    return {
      sql: `SELECT TOP (${this.maxRows + 1}) ${projection.join(', ')} FROM ${qualifiedTable} AS ${sourceAlias} CROSS APPLY (SELECT ${rowBytesExpression} AS [row_bytes]) AS ${metricsAlias}`,
      oversizedKey,
    };
  }

  private uniqueColumnName(columns: string[], preferredName: string): string {
    const columnNames = new Set(columns.map((column) => column.toLowerCase()));
    let name = preferredName;
    let suffix = 2;
    while (columnNames.has(name.toLowerCase())) {
      name = `${preferredName}_${suffix}`;
      suffix += 1;
    }
    return name;
  }

  private quoteIdentifier(value: string, description: string): string {
    if (!value || value.length > 128 || value.includes('\0')) {
      throw new BadRequestException(`El nombre de ${description} no es válido`);
    }
    return `[${value.replace(/]/g, ']]')}]`;
  }
}
