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
import {
  AGGREGATION_OPERATIONS,
  CrossJoinDto,
  ExportCrossJoinDto,
  type AggregationMetricDto,
  type AggregationOperation,
} from './dto/cross-join.dto.js';
import type { DataExtractorOptions } from './adapters/data-extractor.adapter.js';
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

interface AggregateMetricState {
  count: number;
  sum: number;
  masked: boolean;
}

interface AggregateBucket {
  keys: Record<string, any>;
  metrics: Map<string, AggregateMetricState>;
  output: Record<string, any>;
  bytes: number;
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
    this.validateAggregation(payload);

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

    // 2. Aplicar filtros en los adaptadores antes de cargar registros
    const sqlOptions: DataExtractorOptions = {
      ...(payload.esquemaSql ? { schema: payload.esquemaSql } : {}),
      ...(payload.filtrosSql ? { filters: payload.filtrosSql } : {}),
    };
    const noSqlOptions: DataExtractorOptions = payload.filtrosNoSql
      ? { filters: payload.filtrosNoSql }
      : {};
    const [sqlRecords, noSqlRecords] = await Promise.all([
      this.dataExtractor.extract(
        sqlConnection,
        payload.tablaSql,
        Object.keys(sqlOptions).length ? sqlOptions : undefined,
      ),
      this.dataExtractor.extract(
        noSqlConnection,
        payload.coleccionNoSql,
        Object.keys(noSqlOptions).length ? noSqlOptions : undefined,
      ),
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

    // 4. Cruzar filas y, cuando se solicita, conservar solo el estado agregado.
    const joinedRows: Record<string, any>[] = [];
    const groupBy = payload.groupBy ?? [];
    const aggregations = payload.aggregations ?? [];
    const aggregate = groupBy.length > 0 || aggregations.length > 0;
    const aggregateGroups = new Map<string, AggregateBucket>();
    const maxJoinRows = getMaxJoinRows();
    const maxJoinBytes = getMaxJoinBytes();
    let joinedCount = 0;
    let joinedBytes = 0;
    let aggregateBytes = 0;

    if (aggregate && groupBy.length === 0 && aggregations.length > 0) {
      const bucket = this.createAggregateBucket({}, aggregations);
      bucket.output = this.toAggregateRow(bucket, aggregations);
      bucket.bytes = getJsonByteLength(bucket.output);
      aggregateBytes = bucket.bytes;
      aggregateGroups.set('[]', bucket);
    }

    for (const sqlRow of sqlRecords) {
      const keyValue = sqlRow[payload.llaveSql];
      if (keyValue === undefined || keyValue === null) continue;
      const matches = noSqlIndex.get(String(keyValue).trim());
      if (!matches?.length) continue;

      for (const match of matches) {
        if (joinedCount >= maxJoinRows) {
          throw new PayloadTooLargeException(
            `El join supera el máximo de ${maxJoinRows} filas configurado`,
          );
        }
        joinedCount += 1;
        const joinedRow = this.mergeRows(sqlRow, match);

        if (aggregate) {
          // Aggregate the secured source row so arbitrary metric aliases cannot
          // reveal values that are masked for LECTOR users.
          const aggregationRow = this.maskingService.maskRecordForRole(
            joinedRow,
            user.role,
          );
          const groupValues = Object.fromEntries(
            groupBy.map((field) => [
              field,
              this.getOwnValue(aggregationRow, field),
            ]),
          );
          const groupKey = this.serializeGroupValues(
            groupBy.map((field) => this.getOwnValue(aggregationRow, field)),
          );
          let bucket = aggregateGroups.get(groupKey);
          if (!bucket) {
            bucket = this.createAggregateBucket(groupValues, aggregations);
            aggregateGroups.set(groupKey, bucket);
          }
          const oldBytes = bucket.bytes;
          this.addToAggregateBucket(
            bucket,
            joinedRow,
            aggregationRow,
            aggregations,
            user.role,
          );
          bucket.output = this.toAggregateRow(bucket, aggregations);
          bucket.bytes = getJsonByteLength(bucket.output);
          aggregateBytes += bucket.bytes - oldBytes;
          if (aggregateBytes > maxJoinBytes) {
            throw new PayloadTooLargeException(
              `El join supera el máximo de ${maxJoinBytes} bytes configurado`,
            );
          }
          continue;
        }

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

    return aggregate
      ? Array.from(aggregateGroups.values(), (bucket) => bucket.output)
      : joinedRows;
  }

  private validateAggregation(payload: CrossJoinDto): void {
    const groupBy = payload.groupBy ?? [];
    const aggregations = payload.aggregations ?? [];
    const outputFields = new Set(groupBy);

    if (
      groupBy.some((field) => typeof field !== 'string' || !field.trim()) ||
      aggregations.some(
        (metric) =>
          !metric ||
          !AGGREGATION_OPERATIONS.includes(metric.operation) ||
          typeof metric.as !== 'string' ||
          !metric.as.trim() ||
          (metric.operation !== 'COUNT' &&
            (typeof metric.field !== 'string' || !metric.field.trim())),
      )
    ) {
      throw new BadRequestException(
        'La configuración de agregación no es válida',
      );
    }

    for (const metric of aggregations) {
      if (outputFields.has(metric.as)) {
        throw new BadRequestException(
          'Los nombres de grupo y agregación deben ser distintos',
        );
      }
      outputFields.add(metric.as);
    }

    if (outputFields.size !== groupBy.length + aggregations.length) {
      throw new BadRequestException(
        'Los campos de agregación deben ser únicos',
      );
    }
  }

  private createAggregateBucket(
    keys: Record<string, any>,
    aggregations: AggregationMetricDto[],
  ): AggregateBucket {
    const metrics = new Map<string, AggregateMetricState>();
    for (const metric of aggregations) {
      metrics.set(metric.as, { count: 0, sum: 0, masked: false });
    }
    return { keys, metrics, output: {}, bytes: 0 };
  }

  private addToAggregateBucket(
    bucket: AggregateBucket,
    joinedRow: Record<string, any>,
    aggregationRow: Record<string, any>,
    aggregations: AggregationMetricDto[],
    role?: string,
  ): void {
    for (const metric of aggregations) {
      const state = bucket.metrics.get(metric.as)!;
      if (state.masked) continue;
      const rawValue = metric.field
        ? this.getOwnValue(joinedRow, metric.field)
        : undefined;
      if (
        metric.field &&
        this.maskingService.isValueMasked(metric.field, rawValue, role)
      ) {
        state.masked = true;
        continue;
      }
      const value = metric.field
        ? this.getOwnValue(aggregationRow, metric.field)
        : undefined;
      if (metric.operation === 'COUNT') {
        if (!metric.field || (value !== null && value !== undefined)) {
          state.count += 1;
        }
        continue;
      }
      if (value === null || value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new BadRequestException(
          `El campo '${metric.field}' debe contener valores numéricos para ${metric.operation}`,
        );
      }
      state.sum += value;
      if (!Number.isFinite(state.sum)) {
        throw new BadRequestException(
          `El campo '${metric.field}' supera el rango numérico permitido`,
        );
      }
      state.count += 1;
    }
  }

  private toAggregateRow(
    bucket: AggregateBucket,
    aggregations: AggregationMetricDto[],
  ): Record<string, any> {
    const metricEntries = aggregations.map((metric) => {
      const state = bucket.metrics.get(metric.as)!;
      let value: string | number | null;
      if (state.masked) {
        value = '********';
      } else {
        switch (metric.operation as AggregationOperation) {
          case 'COUNT':
            value = state.count;
            break;
          case 'SUM':
            value = state.count ? state.sum : null;
            break;
          case 'AVG':
            value = state.count ? state.sum / state.count : null;
            break;
        }
      }
      return [metric.as, value];
    });
    return Object.fromEntries([
      ...Object.entries(bucket.keys),
      ...metricEntries,
    ]);
  }

  private getOwnValue(row: Record<string, any>, field: string): unknown {
    return Object.prototype.hasOwnProperty.call(row, field)
      ? row[field]
      : undefined;
  }

  private serializeGroupValues(values: unknown[]): string {
    return JSON.stringify(values, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
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
