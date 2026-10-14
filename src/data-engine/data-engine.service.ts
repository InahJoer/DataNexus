import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  PayloadTooLargeException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { ConnectionsService } from '../connections/connections.service.js';
import {
  DATA_EXPLORER_FACTORY,
  type CatalogObject,
  type DataExplorer,
  type DataExplorerFactory,
} from './data-explorer.interface.js';
import { DataExtractorService } from './adapters/data-extractor.adapter.js';
import { MaskingService } from './masking/masking.service.js';
import { ExportService } from './export/export.service.js';
import { CrossJoinDto, ExportCrossJoinDto } from './dto/cross-join.dto.js';
import {
  getJsonByteLength,
  getMaxJoinBytes,
  getMaxJoinRows,
} from './data-engine.constants.js';

const EXPLORATION_TIMEOUT_MS = 10_000;

export interface PaginatedCrossJoinResult {
  total: number;
  limit: number;
  offset: number;
  data: Record<string, any>[];
}

export interface ExportResult {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

@Injectable()
export class DataEngineService {
  constructor(
    private readonly connectionsService: ConnectionsService,
    @Inject(DATA_EXPLORER_FACTORY)
    private readonly createExplorer: DataExplorerFactory,
    private readonly dataExtractor: DataExtractorService = new DataExtractorService(),
    private readonly maskingService: MaskingService = new MaskingService(),
    private readonly exportService: ExportService = new ExportService(),
  ) {}

  async exploreConnection(actor: AuthenticatedUser, connectionId: string) {
    const connection =
      await this.connectionsService.getConnectionForExploration(
        connectionId,
        actor.workspaceId,
      );

    const explorer = this.createExplorer(connection.tipoMotor);
    if (!explorer)
      throw new BadRequestException('Motor de base de datos no soportado');

    const deadline = Date.now() + EXPLORATION_TIMEOUT_MS;
    try {
      const objects = await this.withTimeout(
        explorer.listObjects(connection.connectionString, connection.dbName),
        deadline,
      );

      return {
        connectionId: connection.id,
        tipoMotor: connection.tipoMotor,
        objects: this.sanitizeObjects(objects),
      };
    } catch (error) {
      if (error instanceof GatewayTimeoutException) throw error;
      if (this.isTimeoutError(error)) {
        throw new GatewayTimeoutException(
          'La exploración excedió el tiempo permitido',
        );
      }
      throw new BadGatewayException(
        'No fue posible explorar el esquema de la conexión',
      );
    } finally {
      await this.closeWithinDeadline(explorer, deadline);
    }
  }

  /**
   * Fase 4: Motor de Cross-Joins en memoria con extracción por Adaptador y Paginación.
   * Fase 5: Enmascaramiento de datos si el usuario tiene rol LECTOR.
   */
  async executeCrossJoin(
    payload: CrossJoinDto,
    user: AuthenticatedUser,
  ): Promise<PaginatedCrossJoinResult> {
    const combinedData = await this.performJoin(payload, user);

    // Enmascaramiento si es LECTOR
    const securedData = this.maskingService.maskDataset(
      combinedData,
      user.role,
    );

    // Paginación nativa en memoria
    const limit = payload.limit ?? 50;
    const offset = payload.offset ?? 0;
    const paginatedData = securedData.slice(offset, offset + limit);

    return {
      total: securedData.length,
      limit,
      offset,
      data: paginatedData,
    };
  }

  /**
   * Fase 5: Exportación de datos combinados en Excel, PDF o JSON.
   */
  async executeCrossJoinForExport(
    payload: ExportCrossJoinDto,
    user: AuthenticatedUser,
  ): Promise<ExportResult> {
    const combinedData = await this.performJoin(payload, user);
    const securedData = this.maskingService.maskDataset(
      combinedData,
      user.role,
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    switch (payload.format) {
      case 'excel': {
        const buffer = await this.exportService.exportToExcel(securedData);
        return {
          buffer,
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filename: `datanexus_export_${timestamp}.xlsx`,
        };
      }
      case 'pdf': {
        const buffer = await this.exportService.exportToPdf(
          securedData,
          `DataNexus - Join ${payload.tablaSql} x ${payload.coleccionNoSql}`,
        );
        return {
          buffer,
          contentType: 'application/pdf',
          filename: `datanexus_export_${timestamp}.pdf`,
        };
      }
      case 'json':
      default: {
        const buffer = this.exportService.exportToJson(securedData);
        return {
          buffer,
          contentType: 'application/json',
          filename: `datanexus_export_${timestamp}.json`,
        };
      }
    }
  }

  /**
   * Lógica nuclear de Inner Join en memoria indexada O(N + M).
   */
  private async performJoin(
    payload: CrossJoinDto,
    user: AuthenticatedUser,
  ): Promise<Record<string, any>[]> {
    // 1. Obtener y validar pertenencia al workspace para ambas conexiones
    const [sqlConnection, noSqlConnection] = await Promise.all([
      this.connectionsService.getConnectionForExtraction(
        payload.conexionSqlId,
        user.workspaceId,
      ),
      this.connectionsService.getConnectionForExtraction(
        payload.conexionNoSqlId,
        user.workspaceId,
      ),
    ]);

    // 2. Extraer los datos mediante el Patrón Adaptador
    const [sqlRecords, noSqlRecords] = await Promise.all([
      this.dataExtractor.extract(
        sqlConnection,
        payload.tablaSql,
        payload.esquemaSql ? { schema: payload.esquemaSql } : undefined,
      ),
      this.dataExtractor.extract(noSqlConnection, payload.coleccionNoSql),
    ]);

    // 3. Indexar la colección NoSQL por llaveNoSql para búsqueda en O(1)
    const noSqlIndex = new Map<string, Record<string, any>[]>();
    for (const doc of noSqlRecords) {
      const keyValue = doc[payload.llaveNoSql];
      if (keyValue !== undefined && keyValue !== null) {
        const normalizedKey = String(keyValue).trim();
        const existing = noSqlIndex.get(normalizedKey) ?? [];
        existing.push(doc);
        noSqlIndex.set(normalizedKey, existing);
      }
    }

    // 4. Algoritmo de Inner Join cruzando con la tabla SQL
    const joinedRows: Record<string, any>[] = [];
    const maxJoinRows = getMaxJoinRows();
    const maxJoinBytes = getMaxJoinBytes();
    let joinedBytes = 0;
    for (const sqlRow of sqlRecords) {
      const keyValue = sqlRow[payload.llaveSql];
      if (keyValue !== undefined && keyValue !== null) {
        const normalizedKey = String(keyValue).trim();
        const matches = noSqlIndex.get(normalizedKey);

        if (matches && matches.length > 0) {
          for (const match of matches) {
            if (joinedRows.length >= maxJoinRows) {
              throw new PayloadTooLargeException(
                `El join supera el máximo de ${maxJoinRows} filas configurado`,
              );
            }
            const joinedRow = this.mergeRows(sqlRow, match);
            const rowBytes = getJsonByteLength(joinedRow);
            if (joinedBytes + rowBytes > maxJoinBytes) {
              throw new PayloadTooLargeException(
                `El join supera el máximo de ${maxJoinBytes} bytes configurado`,
              );
            }
            joinedBytes += rowBytes;
            joinedRows.push(joinedRow);
          }
        }
      }
    }

    return joinedRows;
  }

  private mergeRows(
    sqlRow: Record<string, any>,
    noSqlRow: Record<string, any>,
  ): Record<string, any> {
    const duplicateKeys = new Set(
      Object.keys(sqlRow).filter((key) =>
        Object.prototype.hasOwnProperty.call(noSqlRow, key),
      ),
    );
    const merged: Record<string, any> = {};

    for (const [key, value] of Object.entries(sqlRow)) {
      this.assignUnique(
        merged,
        duplicateKeys.has(key) ? `sql.${key}` : key,
        value,
      );
    }
    for (const [key, value] of Object.entries(noSqlRow)) {
      this.assignUnique(
        merged,
        duplicateKeys.has(key) ? `nosql.${key}` : key,
        value,
      );
    }

    return merged;
  }

  private assignUnique(
    target: Record<string, any>,
    preferredKey: string,
    value: any,
  ): void {
    let key = preferredKey;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(target, key)) {
      key = `${preferredKey}_${suffix}`;
      suffix += 1;
    }
    target[key] = value;
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    deadline: number,
  ): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new GatewayTimeoutException('La exploración excedió 10 segundos');
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new GatewayTimeoutException('La exploración excedió 10 segundos'),
            );
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async closeWithinDeadline(
    explorer: DataExplorer,
    deadline: number,
  ): Promise<void> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      void explorer.cancel().catch(() => undefined);
      return;
    }

    let cleanupTimedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const close = explorer.close().catch(() => undefined);
    await Promise.race([
      close,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          cleanupTimedOut = true;
          resolve();
        }, remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (cleanupTimedOut) void explorer.cancel().catch(() => undefined);
  }

  private sanitizeObjects(objects: CatalogObject[]): CatalogObject[] {
    return objects.map(({ name, type, schema }) => ({
      name,
      type,
      ...(schema ? { schema } : {}),
    }));
  }

  private isTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: string }).code;
    return (
      code === 'ETIMEDOUT' ||
      code === 'ETIMEOUT' ||
      code === 'ESOCKETTIMEDOUT' ||
      code === 'ER_QUERY_TIMEOUT' ||
      /timeout|deadline exceeded|maximum statement execution time exceeded/i.test(
        error.message,
      )
    );
  }
}
