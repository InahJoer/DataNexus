import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  ForbiddenException,
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
  type UpdateRecordResult,
} from './adapters/data-source-adapter.interface.js';
import { DataSourceClientPool } from './pool/data-source-client-pool.js';
import { MaskingService, type SensitiveRule } from './masking/masking.service.js';
import { SensitiveFieldsService, type SensitiveSource } from './masking/sensitive-fields.service.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
import { ExportService, WORD_CONTENT_TYPE } from './export/export.service.js';
import type { ConnectionHealthItemDto, ConnectionHealthResponseDto } from './dto/connection-health.dto.js';
import type { ConnectionFieldsResponseDto } from './dto/connection-schema.dto.js';
import {
  AGGREGATION_OPERATIONS,
  CrossJoinDto,
  ExportCrossJoinDto,
  EXPORT_FORMATS,
  type AggregationMetricDto,
  type AggregationOperation,
  type ExportFormat,
} from './dto/cross-join.dto.js';
import {
  getJsonByteLength,
  getMaxJoinBytes,
  getMaxJoinRows,
} from './data-engine.constants.js';
import {
  JOIN_YIELD_EVERY,
  createRowFlattener,
  createRowFlattenerAsync,
  describeJoinPlan,
  executeJoinPlan,
  executeJoinPlanAsync,
  yieldToEventLoop,
  type AsyncJoinOptions,
} from './join/join-plan.js';
import { resolveJoinPlan } from './join/resolve-join-plan.js';
import { assertValidFilters, matchesFilters, parseFilterQuery, splitFiltersForPushdown } from './filters/filter-tree.js';
import {
  DEFAULT_PAGE_SIZE,
  cursorBinding,
  decodeCursor,
  encodeCursor,
  type DataPage,
} from './pagination/keyset.js';
import type { BrowseDataQueryDto, BrowseDataResponseDto } from './dto/browse-data.dto.js';
import type { UpdateRecordDto } from './dto/update-record.dto.js';

const EXPLORATION_TIMEOUT_MS = 10_000;

export interface PaginatedCrossJoinResult {
  total: number;
  limit: number;
  offset: number;
  data: Record<string, any>[];
  /** Límite de filas pedido (RF-16) y si el resultado tenía más filas. */
  limiteFilas?: number;
  truncado?: boolean;
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
    @Optional() private readonly sensitiveFields?: SensitiveFieldsService,
  ) {}

  /**
   * Campos sensibles configurados (RF-20) que aplican a las fuentes de una consulta. Solo se consultan para roles que
   * reciben datos enmascarados; si la consulta falla, falla la petición (nunca se devuelven datos sin enmascarar).
   */
  private async maskingRules(user: AuthenticatedUser, sources: SensitiveSource[]): Promise<SensitiveRule[]> {
    if (hasPermission(user.role, 'VIEW_UNMASKED_DATA') || !this.sensitiveFields) return [];
    return this.sensitiveFields.rulesFor(user.workspaceId, sources);
  }

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
   * Exploración paginada de una tabla o colección con cursores nativos (RNF-06, issue #32). Cada página lee como
   * mucho `limite + 1` filas en el motor (keyset en SQL, `_id` en MongoDB, `startAfter` en Firestore), así que se
   * puede recorrer una tabla de millones de filas con memoria constante. El cursor es opaco y solo vale para la
   * misma conexión, esquema y entidad.
   */
  async browseData(actor: AuthenticatedUser, connectionId: string, query: BrowseDataQueryDto): Promise<BrowseDataResponseDto> {
    const filters = parseFilterQuery(query.filtros);
    const binding = cursorBinding(connectionId, query.entidad, query.esquema);
    const after = query.cursor ? decodeCursor(query.cursor, binding) : undefined;
    const pageSize = query.limite ?? DEFAULT_PAGE_SIZE;

    const connection = await this.connectionsService.getConnectionForExploration(connectionId, actor.workspaceId);
    const adapter = this.adapters.get(connection.tipoMotor);
    if (!adapter?.readPage) {
      throw new BadRequestException('La exploración paginada no está disponible para este motor');
    }
    const { pushed, residual } = splitFiltersForPushdown(
      filters,
      (filter) => adapter.canPushDown?.(filter) ?? true,
      adapter.pushesFilterGroups ?? true,
    );

    let page: DataPage;
    try {
      page = await this.runWithDeadline(connection, Date.now() + EXPLORATION_TIMEOUT_MS, () =>
        adapter.readPage!(connection, query.entidad, {
          ...(query.esquema ? { schema: query.esquema } : {}),
          ...(pushed.length ? { filters: pushed } : {}),
          pageSize,
          ...(after ? { after } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (this.isTimeoutError(error)) throw new GatewayTimeoutException('La lectura de la página excedió el tiempo permitido');
      this.logger.warn(`Falló la lectura paginada en la conexión ${connection.id} (${adapter.tipoMotor})`);
      throw new BadGatewayException('No fue posible leer datos de la fuente externa');
    }

    // Lo que el motor no pudo filtrar se aplica a la página; el cursor sigue avanzando por la última fila leída.
    const rows = residual.length ? page.rows.filter((row) => matchesFilters(row, residual)) : page.rows;
    const rules = await this.maskingRules(actor, [{ conexionId: connection.id, entidad: query.entidad }]);
    const data = this.maskingService.maskDataset(rows, actor.role, rules);
    return {
      entidad: query.entidad,
      ...(query.esquema ? { esquema: query.esquema } : {}),
      limite: pageSize,
      orden: page.orderBy,
      filas: data.length,
      data,
      nextCursor: page.lastKey ? encodeCursor(binding, page.lastKey) : null,
    };
  }

  async updateRecord(actor: AuthenticatedUser, input: UpdateRecordDto) {
    if (!hasPermission(actor.role, 'MODIFY_RECORDS')) {
      throw new ForbiddenException('Se requiere rol ADMIN u OPERADOR para editar registros');
    }

    const connection = await this.connectionsService.getConnectionForExploration(input.conexionId, actor.workspaceId);
    const adapter = this.adapters.get(connection.tipoMotor);
    if (!adapter?.updateRecord) {
      throw new BadRequestException('La edición no está disponible para este motor');
    }

    let updatedValues: UpdateRecordResult;
    try {
      updatedValues = await adapter.updateRecord(connection, {
        entityName: input.entidad,
        ...(input.esquema ? { schema: input.esquema } : {}),
        primaryKey: input.llavePrimaria,
        field: input.campo,
        expectedValue: input.valorAnterior,
        nextValue: input.valorNuevo,
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (this.isTimeoutError(error)) throw new GatewayTimeoutException('La actualización excedió el tiempo permitido');
      this.logger.warn(`Falló la actualización en la conexión ${connection.id} (${adapter.tipoMotor})`);
      throw new BadGatewayException('No fue posible actualizar el registro en la fuente externa');
    }

    return {
      actualizada: true,
      entidad: input.entidad,
      campo: input.campo,
      valorAnterior: updatedValues.valueBefore,
      valorNuevo: updatedValues.valueAfter,
    };
  }

  /**
   * Fase 4: Motor de Cross-Joins en memoria con extracción por Adaptador y Paginación.
   * Fase 5: Enmascaramiento de datos si el usuario tiene rol LECTOR.
   */
  async executeCrossJoin(
    payload: CrossJoinDto,
    user: AuthenticatedUser,
  ): Promise<PaginatedCrossJoinResult> {
    const { rows: combinedData, truncated, rules } = await this.performJoin(payload, user);

    // Enmascaramiento si es LECTOR
    const securedData = this.maskingService.maskDataset(combinedData, user.role, rules);

    // Paginación nativa en memoria
    const limit = payload.limit ?? 50;
    const offset = payload.offset ?? 0;
    const paginatedData = securedData.slice(offset, offset + limit);

    return {
      total: securedData.length,
      limit,
      offset,
      data: paginatedData,
      ...(payload.limiteFilas ? { limiteFilas: payload.limiteFilas, truncado: truncated } : {}),
    };
  }

  /**
   * Fase 5: Exportación de datos combinados en Excel, PDF, Word o JSON.
   */
  async executeCrossJoinForExport(
    payload: ExportCrossJoinDto,
    user: AuthenticatedUser,
  ): Promise<ExportResult> {
    const { rows: combinedData, rules } = await this.performJoin(payload, user);
    const securedData = this.maskingService.maskDataset(combinedData, user.role, rules);

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
          `DataNexus - Join ${describeJoinPlan(resolveJoinPlan(payload))}`,
        );
        return {
          buffer,
          contentType: 'application/pdf',
          filename: `datanexus_export_${timestamp}.pdf`,
          totalRows: securedData.length,
        };
      }
      case 'word': {
        const buffer = await this.exportService.exportToWord(securedData, {
          title: `DataNexus - Join ${describeJoinPlan(resolveJoinPlan(payload))}`,
          masked: !hasPermission(user.role, 'VIEW_UNMASKED_DATA'),
        });
        return {
          buffer,
          contentType: WORD_CONTENT_TYPE,
          filename: `datanexus_export_${timestamp}.docx`,
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
    if (!EXPORT_FORMATS.includes(payload.format as ExportFormat)) {
      throw new BadRequestException('Formato de reporte no válido');
    }

    const { rows: combinedData, rules } = await this.performJoin(payload, user);
    const securedData = this.maskingService.maskDataset(combinedData, user.role, rules);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (payload.format === 'excel') {
      await this.exportService.writeExcel(securedData, destination);
      return {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `datanexus_export_${timestamp}.xlsx`,
        totalRows: securedData.length,
      };
    }

    if (payload.format === 'word') {
      await this.exportService.writeWord(
        securedData,
        {
          title: `DataNexus - Join ${describeJoinPlan(resolveJoinPlan(payload))}`,
          masked: !hasPermission(user.role, 'VIEW_UNMASKED_DATA'),
        },
        destination,
      );
      return {
        contentType: WORD_CONTENT_TYPE,
        filename: `datanexus_export_${timestamp}.docx`,
        totalRows: securedData.length,
      };
    }

    if (payload.format === 'pdf') {
      await this.exportService.writePdf(
        securedData,
        `DataNexus - Join ${describeJoinPlan(resolveJoinPlan(payload))}`,
        destination,
      );
      return {
        contentType: 'application/pdf',
        filename: `datanexus_export_${timestamp}.pdf`,
        totalRows: securedData.length,
      };
    }

    await this.exportService.writeJson(securedData, destination);
    return {
      contentType: 'application/json',
      filename: `datanexus_export_${timestamp}.json`,
      totalRows: securedData.length,
    };
  }

  /**
   * Lógica nuclear de Inner Join en memoria indexada O(N + M).
   */
  /**
   * Cross-join para un job asíncrono (RNF-04, issue #33): mismo resultado que `executeCrossJoin` (filtros,
   * agregaciones, limiteFilas y enmascaramiento según el rol de quien lo pidió), sin paginar, pero cediendo el event
   * loop durante el join, informando el progreso (0 a 1) y deteniéndose si se cancela.
   */
  async runCrossJoinJob(
    payload: CrossJoinDto,
    user: AuthenticatedUser,
    options: AsyncJoinOptions = {},
  ): Promise<{ rows: Record<string, any>[]; truncated: boolean }> {
    const { rows, truncated, rules } = await this.performJoin(payload, user, { ...options, cooperative: true });
    options.signal?.throwIfAborted();
    const secured = this.maskingService.maskDataset(rows, user.role, rules);
    options.onProgress?.(1);
    return { rows: secured, truncated };
  }

  private async performJoin(
    payload: CrossJoinDto,
    user: AuthenticatedUser,
    options: AsyncJoinOptions & { cooperative?: boolean } = {},
  ): Promise<{ rows: Record<string, any>[]; truncated: boolean; rules: SensitiveRule[] }> {
    this.validateAggregation(payload);
    // Progreso de un job: extracción 0-40 %, join 40-80 %, armado de filas 80-100 %.
    const report = (from: number, to: number) => (fraction: number) =>
      options.onProgress?.(from + (to - from) * Math.min(1, Math.max(0, fraction)));

    const plan = resolveJoinPlan(payload);
    const rules = await this.maskingRules(
      user,
      plan.sources.map((source) => ({ conexionId: source.conexionId, entidad: source.entidad })),
    );

    // 1. Obtener y validar pertenencia al workspace de cada conexión (una vez por conexión)
    const connectionIds = [...new Set(plan.sources.map((source) => source.conexionId))];
    const connections = new Map(
      await Promise.all(
        connectionIds.map(
          async (id) =>
            [id, await this.connectionsService.getConnectionForExploration(id, user.workspaceId)] as const,
        ),
      ),
    );

    // 2. Extraer cada fuente aplicando sus filtros en el motor (filter pushdown)
    const extracted = await Promise.all(
      plan.sources.map(async (source) => {
        const options: ExtractOptions = {
          ...(source.esquema ? { schema: source.esquema } : {}),
          ...(source.filtros?.length ? { filters: source.filtros } : {}),
        };
        const records = await this.extract(
          connections.get(source.conexionId)!,
          source.entidad,
          Object.keys(options).length ? options : undefined,
        );
        return [source.alias, records] as const;
      }),
    );
    const recordsByAlias = new Map(extracted);

    // 3. Ejecutar las relaciones (INNER/LEFT/RIGHT/FULL) con índices hash y aplanar las filas
    options.signal?.throwIfAborted();
    report(0, 0.4)(1);
    const tuples = options.cooperative
      ? await executeJoinPlanAsync(plan, recordsByAlias, getMaxJoinRows(), {
          signal: options.signal,
          onProgress: report(0.4, 0.8),
        })
      : executeJoinPlan(plan, recordsByAlias, getMaxJoinRows());
    const flatten = options.cooperative
      ? await createRowFlattenerAsync(plan, recordsByAlias, options.signal)
      : createRowFlattener(plan, recordsByAlias);

    // 4. Recorrer las filas unidas y, cuando se solicita, conservar solo el estado agregado.
    const joinedRows: Record<string, any>[] = [];
    const groupBy = payload.groupBy ?? [];
    const aggregations = payload.aggregations ?? [];
    const aggregate = groupBy.length > 0 || aggregations.length > 0;
    const aggregateGroups = new Map<string, AggregateBucket>();
    const maxJoinBytes = getMaxJoinBytes();
    let joinedBytes = 0;
    let aggregateBytes = 0;

    if (aggregate && groupBy.length === 0 && aggregations.length > 0) {
      const bucket = this.createAggregateBucket({}, aggregations);
      bucket.output = this.toAggregateRow(bucket, aggregations);
      bucket.bytes = getJsonByteLength(bucket.output);
      aggregateBytes = bucket.bytes;
      aggregateGroups.set('[]', bucket);
    }

    for (const [tupleIndex, tuple] of tuples.entries()) {
      if (options.cooperative && tupleIndex > 0 && tupleIndex % JOIN_YIELD_EVERY === 0) {
        options.signal?.throwIfAborted();
        report(0.8, 1)(tupleIndex / tuples.length);
        await yieldToEventLoop();
      }
      const joinedRow = flatten(tuple);

      if (aggregate) {
        // Aggregate the secured source row so arbitrary metric aliases cannot
        // reveal values that are masked for LECTOR users.
        const aggregationRow = this.maskingService.maskRecordForRole(joinedRow, user.role, rules);
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
          rules,
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

    const rows = aggregate ? Array.from(aggregateGroups.values(), (bucket) => bucket.output) : joinedRows;
    // RF-16: el usuario puede limitar el resultado a 50, 100, 500 o 1000 filas.
    const rowLimit = payload.limiteFilas;
    return rowLimit && rows.length > rowLimit
      ? { rows: rows.slice(0, rowLimit), truncated: true, rules }
      : { rows, truncated: false, rules };
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
    rules?: SensitiveRule[],
  ): void {
    for (const metric of aggregations) {
      const state = bucket.metrics.get(metric.as)!;
      if (state.masked) continue;
      const rawValue = metric.field
        ? this.getOwnValue(joinedRow, metric.field)
        : undefined;
      if (
        metric.field &&
        this.maskingService.isValueMasked(metric.field, rawValue, role, rules)
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

    // Filter pushdown: el motor ejecuta lo que puede; el resto se evalúa en memoria con la misma semántica.
    assertValidFilters(options?.filters);
    const { pushed, residual } = splitFiltersForPushdown(
      options?.filters,
      (filter) => adapter.canPushDown?.(filter) ?? true,
      adapter.pushesFilterGroups ?? true,
    );
    const adapterOptions: ExtractOptions = {
      ...(options?.schema ? { schema: options.schema } : {}),
      ...(pushed.length ? { filters: pushed } : {}),
    };

    try {
      const records = await adapter.extract(
        connection,
        entityName,
        Object.keys(adapterOptions).length ? adapterOptions : undefined,
      );
      return residual.length ? records.filter((record) => matchesFilters(record, residual)) : records;
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
