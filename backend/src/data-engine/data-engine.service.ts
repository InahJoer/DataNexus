import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Writable } from 'node:stream';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { ConnectionsService } from '../connections/connections.service.js';
import { AdapterRegistry } from './adapters/adapter-registry.js';
import {
  UnsupportedOperationError,
  type CatalogObject,
  type DataSourceConnection,
  type ExtractOptions,
} from './adapters/data-source-adapter.interface.js';
import { DataSourceClientPool } from './pool/data-source-client-pool.js';
import { MaskingService } from './masking/masking.service.js';
import { ExportService } from './export/export.service.js';
import type { ConnectionHealthItemDto, ConnectionHealthResponseDto } from './dto/connection-health.dto.js';
import type { ConnectionFieldsResponseDto } from './dto/connection-schema.dto.js';
import {
  AGGREGATION_OPERATIONS,
  CrossJoinDto,
  ExportCrossJoinDto,
  type AggregationMetricDto,
  type AggregationOperation,
} from './dto/cross-join.dto.js';
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
  /** Filas incluidas en el archivo (para la bitácora). */
  totalRows: number;
}

export interface StreamExportResult {
  contentType: string;
  filename: string;
  totalRows: number;
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
  private readonly logger = new Logger(DataEngineService.name);

  /**
   * El servicio solo conoce IDataSourceAdapter a través de AdapterRegistry (RNF-10): agregar un motor no lo
   * modifica. El pool se usa para descartar los clientes de una conexión que excedió el tiempo.
   */
  constructor(
    private readonly connectionsService: ConnectionsService,
    private readonly adapters: AdapterRegistry,
    @Optional() private readonly clientPool?: DataSourceClientPool,
    private readonly maskingService: MaskingService = new MaskingService(),
    private readonly exportService: ExportService = new ExportService(),
  ) {}

  async getConnectionsHealth(actor: AuthenticatedUser): Promise<ConnectionHealthResponseDto> {
    const connections = await this.withTimeout(
      this.connectionsService.findAll(actor),
      Date.now() + EXPLORATION_TIMEOUT_MS,
    );
    const healthItems = await Promise.all(
      connections.map(async (connection): Promise<ConnectionHealthItemDto> => {
        const startedAt = Date.now();
        const adapter = this.adapters.get(connection.tipoMotor);
        const base = {
          connectionId: connection.id,
          tipoMotor: connection.tipoMotor,
          host: connection.host,
          dbName: connection.dbName,
        };

        if (!adapter?.capabilities.explore) {
          return { ...base, status: 'UNSUPPORTED', latencyMs: null };
        }

        const deadline = startedAt + EXPLORATION_TIMEOUT_MS;
        try {
          const credentials = await this.withTimeout(
            this.connectionsService.getConnectionForExploration(connection.id, actor.workspaceId),
            deadline,
          );
          await this.runWithDeadline(credentials, deadline, () => adapter.listObjects(credentials));
          return { ...base, status: 'HEALTHY', latencyMs: Date.now() - startedAt };
        } catch {
          return { ...base, status: 'UNAVAILABLE', latencyMs: Date.now() - startedAt };
        }
      }),
    );

    return { checkedAt: new Date().toISOString(), connections: healthItems };
  }

  async exploreConnection(actor: AuthenticatedUser, connectionId: string) {
    const connection =
      await this.connectionsService.getConnectionForExploration(
        connectionId,
        actor.workspaceId,
      );

    const adapter = this.adapters.get(connection.tipoMotor);
    if (!adapter?.capabilities.explore)
      throw new BadRequestException('Motor de base de datos no soportado');

    const deadline = Date.now() + EXPLORATION_TIMEOUT_MS;
    try {
      const objects = await this.runWithDeadline(connection, deadline, () => adapter.listObjects(connection));

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
    }
  }

  async exploreConnectionFields(
    actor: AuthenticatedUser,
    connectionId: string,
    objectName: string,
    schema?: string,
  ): Promise<ConnectionFieldsResponseDto> {
    const connection = await this.connectionsService.getConnectionForExploration(
      connectionId,
      actor.workspaceId,
    );
    const adapter = this.adapters.get(connection.tipoMotor);
    if (!adapter?.capabilities.fields) {
      throw new BadRequestException('La exploración de campos no está disponible para este motor');
    }

    const deadline = Date.now() + EXPLORATION_TIMEOUT_MS;
    try {
      const objects = await this.runWithDeadline(connection, deadline, () => adapter.listObjects(connection));
      const objectExists = objects.some((object) =>
        object.name === objectName && (!schema || object.schema === schema),
      );
      if (!objectExists) throw new NotFoundException('Tabla o colección no encontrada en la conexión');

      const fields = await this.runWithDeadline(connection, deadline, () =>
        adapter.listFields(connection, objectName, schema),
      );
      return {
        connectionId: connection.id,
        objectName,
        fields: [...new Set(fields)].filter((field) => typeof field === 'string' && field.length > 0),
      };
    } catch (error) {
      if (error instanceof GatewayTimeoutException || error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      if (this.isTimeoutError(error)) {
        throw new GatewayTimeoutException('La exploración de campos excedió el límite de 10 segundos');
      }
      throw new BadGatewayException('No fue posible explorar los campos de la fuente');
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
          totalRows: securedData.length,
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
          totalRows: securedData.length,
        };
      }
      case 'json':
      default: {
        const buffer = this.exportService.exportToJson(securedData);
        return {
          buffer,
          contentType: 'application/json',
          filename: `datanexus_export_${timestamp}.json`,
          totalRows: securedData.length,
        };
      }
    }
  }

  async executeCrossJoinToStream(
    payload: ExportCrossJoinDto,
    user: AuthenticatedUser,
    destination: Writable,
  ): Promise<StreamExportResult> {
    if (payload.format !== 'excel' && payload.format !== 'pdf') {
      throw new BadRequestException('Los reportes solo admiten formato Excel o PDF');
    }

    const combinedData = await this.performJoin(payload, user);
    const securedData = this.maskingService.maskDataset(combinedData, user.role);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (payload.format === 'excel') {
      await this.exportService.writeExcel(securedData, destination);
      return {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `datanexus_export_${timestamp}.xlsx`,
        totalRows: securedData.length,
      };
    }

    await this.exportService.writePdf(
      securedData,
      `DataNexus - Join ${payload.tablaSql} x ${payload.coleccionNoSql}`,
      destination,
    );
    return {
      contentType: 'application/pdf',
      filename: `datanexus_export_${timestamp}.pdf`,
      totalRows: securedData.length,
    };
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
      this.connectionsService.getConnectionForExploration(
        payload.conexionSqlId,
        user.workspaceId,
      ),
      this.connectionsService.getConnectionForExploration(
        payload.conexionNoSqlId,
        user.workspaceId,
      ),
    ]);

    // 2. Aplicar filtros en los adaptadores antes de cargar registros (filter pushdown)
    const sqlOptions: ExtractOptions = {
      ...(payload.esquemaSql ? { schema: payload.esquemaSql } : {}),
      ...(payload.filtrosSql ? { filters: payload.filtrosSql } : {}),
    };
    const noSqlOptions: ExtractOptions = payload.filtrosNoSql
      ? { filters: payload.filtrosNoSql }
      : {};
    const [sqlRecords, noSqlRecords] = await Promise.all([
      this.extract(
        sqlConnection,
        payload.tablaSql,
        Object.keys(sqlOptions).length ? sqlOptions : undefined,
      ),
      this.extract(
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

  /**
   * Extrae una tabla o colección con el adaptador del motor. Los errores del proveedor no se exponen
   * (pueden contener datos de conexión): solo los HTTP propios, el timeout y un 502 genérico.
   */
  private async extract(
    connection: DataSourceConnection,
    entityName: string,
    options?: ExtractOptions,
  ): Promise<Record<string, any>[]> {
    const adapter = this.adapters.get(connection.tipoMotor);
    if (!adapter?.capabilities.extract) {
      throw new BadRequestException('El motor de la conexión no tiene un extractor real disponible');
    }
    this.logger.log(`Extrayendo '${entityName}' de la conexión ${connection.id} (${adapter.tipoMotor})`);

    try {
      return await adapter.extract(connection, entityName, options);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof UnsupportedOperationError) {
        throw new BadRequestException('El motor de la conexión no tiene un extractor real disponible');
      }
      if (this.isTimeoutError(error)) {
        void this.clientPool?.invalidate(connection.id);
        throw new GatewayTimeoutException('La extracción excedió el tiempo permitido');
      }
      this.logger.warn(`Falló la extracción en la conexión ${connection.id} (${adapter.tipoMotor})`);
      throw new BadGatewayException('No fue posible extraer datos de la fuente externa');
    }
  }

  /**
   * Ejecuta una operación del adaptador con el plazo de exploración. Si se vence, descarta los clientes de la
   * conexión en el pool para no reutilizar una conexión colgada.
   */
  private async runWithDeadline<T>(
    connection: DataSourceConnection,
    deadline: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.withTimeout(operation(), deadline);
    } catch (error) {
      if (error instanceof GatewayTimeoutException || this.isTimeoutError(error)) {
        void this.clientPool?.invalidate(connection.id);
      }
      throw error;
    }
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
      code === 'DEADLINE_EXCEEDED' ||
      /timeout|deadline exceeded|maximum statement execution time exceeded/i.test(
        error.message,
      )
    );
  }
}
