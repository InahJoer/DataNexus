import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { FieldPath, Firestore, Timestamp, type Query, type QueryDocumentSnapshot, type WhereFilterOp } from '@google-cloud/firestore';
import { toDataPage, type DataPage, type DataPageOptions } from '../pagination/keyset.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';
import {
  EXTERNAL_QUERY_TIMEOUT_MS,
  getJsonByteLength,
  getMaxSourceBytes,
  getMaxSourceRows,
} from '../data-engine.constants.js';
import {
  assertValidFilters,
  isFilterGroup,
  matchesFilters,
  type DataFilter,
  type FilterNode,
  type FilterOperator,
} from '../filters/filter-tree.js';
import type {
  CatalogObject,
  DataSourceConnection,
  ExtractOptions,
  IDataSourceAdapter,
  UpdateRecordInput,
  UpdateRecordResult,
} from './data-source-adapter.interface.js';
import { assertExpectedCellValue, decodeBase64CellValue, normalizeCellValue } from './cell-update.js';

/** Operadores que Firestore ejecuta en el servidor; contains, startsWith y los grupos OR se evalúan en memoria. */
const WHERE_FILTER_OPERATORS: Partial<Record<FilterOperator, WhereFilterOp>> = {
  eq: '==',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  in: 'in',
  'not-in': 'not-in',
};

/**
 * Entidad de Firestore:
 * - `clientes` o `clientes/{id}/pedidos`: una colección concreta (raíz o subcolección de un documento).
 * - `clientes/*` + `/pedidos`: grupo con todas las subcolecciones `pedidos` de los documentos de `clientes`. Cada fila
 *   lleva `__parentId` (id del documento padre) y `__path` (ruta completa) para poder cruzarla con su colección padre.
 */
type FirestoreEntity = { kind: 'collection'; path: string } | { kind: 'group'; parent: string; id: string };

const ENTITY_ERROR = 'Colección no válida: usa coleccion, coleccion/{id}/subcoleccion o coleccion/*/subcoleccion';
/** Muestreo para descubrir subcolecciones: documentos por colección raíz y colecciones raíz revisadas. */
const SUBCOLLECTION_SAMPLE_DOCS = 5;
const SUBCOLLECTION_SAMPLE_ROOTS = 25;

function isValidSegment(segment: string): boolean {
  return segment.length > 0 && segment.length <= 150 && !/[/\0*]/.test(segment) && segment !== '.' && segment !== '..' && !/^__.*__$/.test(segment);
}

export function parseFirestoreEntity(name: string): FirestoreEntity {
  const parts = typeof name === 'string' ? name.split('/') : [];
  if (parts.length === 3 && parts[1] === '*' && isValidSegment(parts[0]) && isValidSegment(parts[2])) {
    return { kind: 'group', parent: parts[0], id: parts[2] };
  }
  if (parts.length % 2 === 1 && parts.length <= 7 && parts.every(isValidSegment)) return { kind: 'collection', path: name };
  throw new BadRequestException(ENTITY_ERROR);
}

interface FirestoreServiceAccount {
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
}

/** Firestore: colecciones raíz y subcolecciones, campos por muestreo y extracción con filtros, con un cliente reutilizable. */
@Injectable()
export class FirestoreAdapter implements IDataSourceAdapter {
  readonly tipoMotor = 'FIRESTORE' as const;
  readonly capabilities = { explore: true, fields: true, extract: true };
  readonly pushesFilterGroups = false;

  constructor(private readonly clients: DataSourceClientPool) {}

  canPushDown(filter: DataFilter): boolean {
    return filter.operador in WHERE_FILTER_OPERATORS || filter.operador === 'between' || filter.operador === 'isNull';
  }

  listObjects(connection: DataSourceConnection): Promise<CatalogObject[]> {
    return this.withClient(connection, async (firestore) => {
      const collections = await firestore.listCollections();
      const objects: CatalogObject[] = collections.map((collection) => ({ name: collection.id, type: 'COLLECTION' as const }));
      // Firestore no lista subcolecciones globalmente: se descubren en una muestra de documentos de cada colección raíz.
      const groups = new Set<string>();
      await Promise.all(
        collections.slice(0, SUBCOLLECTION_SAMPLE_ROOTS).map(async (collection) => {
          const sample = await collection.limit(SUBCOLLECTION_SAMPLE_DOCS).get();
          for (const document of sample.docs) {
            for (const sub of await document.ref.listCollections()) groups.add(`${collection.id}/*/${sub.id}`);
          }
        }),
      );
      for (const name of [...groups].sort()) objects.push({ name, type: 'COLLECTION' });
      return objects;
    });
  }

  /** Campos del primer documento de la colección (Firestore no tiene esquema). */
  async listFields(connection: DataSourceConnection, collectionName: string): Promise<string[]> {
    const entity = parseFirestoreEntity(collectionName);
    return await this.withClient(connection, async (firestore) => {
      const snapshot = await this.baseQuery(firestore, entity).limit(entity.kind === 'group' ? 50 : 1).get();
      const document = snapshot.docs.find((doc) => this.belongs(doc, entity));
      if (!document) return [];
      const fields = Object.keys(document.data() ?? {});
      return entity.kind === 'group' ? ['__parentId', ...fields] : fields;
    });
  }

  async extract(
    connection: DataSourceConnection,
    collectionName: string,
    options: ExtractOptions = {},
  ): Promise<Record<string, any>[]> {
    const entity = parseFirestoreEntity(collectionName);
    const filters = this.validateFilters(options.filters);
    const maxRows = getMaxSourceRows();
    const maxBytes = getMaxSourceBytes();

    return await this.withClient(connection, async (firestore) => {
      let query: Query = this.baseQuery(firestore, entity);
      // En los grupos los filtros se evalúan en memoria: en el servidor exigirían índices de grupo de colecciones.
      if (entity.kind === 'collection') for (const filter of filters) query = this.applyFilter(query, filter);
      const stream = query.limit(maxRows + 1).stream() as NodeJS.ReadableStream & { destroy(error?: Error): unknown };
      const timeout = setTimeout(
        () => stream.destroy(Object.assign(new Error('Firestore query timeout'), { code: 'DEADLINE_EXCEEDED' })),
        EXTERNAL_QUERY_TIMEOUT_MS,
      );
      timeout.unref?.();

      try {
        const rows: Record<string, any>[] = [];
        let totalBytes = 0;
        for await (const document of stream as AsyncIterable<QueryDocumentSnapshot>) {
          if (!this.belongs(document, entity)) continue;
          if (rows.length >= maxRows) {
            throw new PayloadTooLargeException(`La colección supera el máximo de ${maxRows} documentos configurado`);
          }
          const row = this.toRow(document, entity);
          // Misma semántica que SQL: Firestore incluye los null en != y not-in; aquí se descartan.
          if (!matchesFilters(row, filters)) continue;
          const rowBytes = getJsonByteLength(row);
          if (totalBytes + rowBytes > maxBytes) {
            throw new PayloadTooLargeException(`La colección supera el máximo de ${maxBytes} bytes configurado`);
          }
          totalBytes += rowBytes;
          rows.push(row);
        }
        return rows;
      } finally {
        clearTimeout(timeout);
        stream.destroy();
      }
    });
  }

  /**
   * Página con cursor nativo de Firestore (RNF-06): orden por id de documento y `startAfter(último id)`.
   * Solo las igualdades (eq, in, isNull: true) se envían con la consulta, porque combinarlas con el orden por id no
   * requiere índices compuestos; el resto de filtros se aplica a los documentos leídos. Una página puede traer menos
   * filas que las pedidas y seguir teniendo `nextCursor`.
   */
  async readPage(connection: DataSourceConnection, collectionName: string, options: DataPageOptions): Promise<DataPage> {
    const entity = parseFirestoreEntity(collectionName);
    const filters = this.validateFilters(options.filters);
    const server = entity.kind === 'group' ? [] : filters.filter(
      (filter) => filter.operador === 'eq' || filter.operador === 'in' || (filter.operador === 'isNull' && filter.valor === true),
    );
    if (options.after && (options.after.length !== 1 || typeof options.after[0] !== 'string')) {
      throw new BadRequestException('El cursor no es válido para esta fuente');
    }

    return await this.withClient(connection, async (firestore) => {
      let query: Query = this.baseQuery(firestore, entity);
      for (const filter of server) query = this.applyFilter(query, filter);
      query = query.orderBy(FieldPath.documentId());
      // En un grupo el orden es por ruta completa, así que el cursor también lo es.
      if (options.after) query = query.startAfter(options.after[0] as string);
      const snapshot = await query.limit(options.pageSize + 1).get();
      const raw = snapshot.docs.map((document) => ({
        ...this.toRow(document, entity),
        __cursor: entity.kind === 'group' ? document.ref.path : document.id,
      }));
      const page = toDataPage(raw, ['__cursor'], options.pageSize, ({ __cursor: _cursor, ...row }) => row);
      // El cursor avanza por el último documento leído aunque los filtros en memoria lo descarten.
      return {
        ...page,
        orderBy: [entity.kind === 'group' ? '__path' : '__documentId'],
        rows: page.rows.filter((row) => this.belongs(row, entity) && matchesFilters(row, filters)),
      };
    });
  }

  async updateRecord(connection: DataSourceConnection, input: UpdateRecordInput): Promise<UpdateRecordResult> {
    const entity = parseFirestoreEntity(input.entityName);
    if (input.schema !== undefined) throw new BadRequestException('Firestore no admite esquemas');
    const key = input.primaryKey;
    // En una colección la llave es el id del documento; en un grupo, su ruta completa (columna __path).
    const keyParts = typeof key === 'string' ? key.split('/') : [];
    const validKey =
      entity.kind === 'collection'
        ? keyParts.length === 1 && isValidSegment(keyParts[0])
        : keyParts.length === 4 && keyParts[0] === entity.parent && keyParts[2] === entity.id && keyParts.every(isValidSegment);
    if (!validKey) throw new BadRequestException('Firestore requiere un ID de documento válido');
    if (!input.field || input.field.length > 128 || input.field.includes('\0')) {
      throw new BadRequestException('El nombre del campo no es válido');
    }

    return await this.withClient(connection, async (firestore) => {
      const document = entity.kind === 'collection' ? firestore.collection(entity.path).doc(key as string) : firestore.doc(key as string);
      return await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(document);
        if (!snapshot.exists) throw new NotFoundException('El documento no existe en la colección');
        const data = snapshot.data() ?? {};
        if (!Object.prototype.hasOwnProperty.call(data, input.field)) {
          throw new ConflictException('El valor de la celda cambió desde la última lectura');
        }
        const currentValue = data[input.field];
        const valueBefore = assertExpectedCellValue(currentValue, input.expectedValue);
        let nextValue: unknown = input.nextValue;
        const isBytes = currentValue instanceof Uint8Array || (
          typeof currentValue === 'object' && currentValue !== null &&
          'toBase64' in currentValue && typeof currentValue.toBase64 === 'function'
        );
        if (isBytes && typeof nextValue === 'string') {
          nextValue = decodeBase64CellValue(input.nextValue);
        } else if (currentValue instanceof Timestamp && typeof nextValue === 'string') {
          const date = new Date(nextValue);
          if (Number.isNaN(date.getTime())) throw new BadRequestException('El valor de fecha debe ser ISO 8601 válido');
          nextValue = Timestamp.fromDate(date);
        } else if (currentValue instanceof Date && typeof nextValue === 'string') {
          const date = new Date(nextValue);
          if (Number.isNaN(date.getTime())) throw new BadRequestException('El valor de fecha debe ser ISO 8601 válido');
          nextValue = date;
        }
        transaction.update(document, new FieldPath(input.field), nextValue);
        return { valueBefore, valueAfter: normalizeCellValue(nextValue) };
      });
    });
  }

  private withClient<R>(connection: DataSourceConnection, use: (firestore: Firestore) => Promise<R>): Promise<R> {
    return this.clients.withClient(
      { connectionId: connection.id, connectionString: connection.connectionString, variant: connection.dbName },
      async () => this.createClient(connection),
      (firestore) => firestore.terminate(),
      use,
    );
  }

  private createClient(connection: DataSourceConnection): Firestore {
    let account: FirestoreServiceAccount;
    try {
      account = JSON.parse(connection.connectionString) as FirestoreServiceAccount;
    } catch {
      throw new BadRequestException('La credencial de Firestore debe ser JSON válido');
    }
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
    const projectId = text(account?.project_id);
    const clientEmail = text(account?.client_email);
    const privateKey = text(account?.private_key);
    if (!projectId || !clientEmail || !privateKey) {
      throw new BadRequestException('La cuenta de servicio de Firestore está incompleta');
    }

    return new Firestore({
      projectId,
      databaseId: connection.dbName && connection.dbName !== '(default)' ? connection.dbName : undefined,
      credentials: { client_email: clientEmail, private_key: privateKey },
      clientConfig: {
        interfaces: {
          'google.firestore.v1.Firestore': {
            methods: {
              ListCollectionIds: {
                timeout_millis: EXTERNAL_QUERY_TIMEOUT_MS,
                retry_codes_name: 'non_idempotent',
                retry_params_name: 'default',
              },
            },
          },
        },
      },
    });
  }

  private baseQuery(firestore: Firestore, entity: FirestoreEntity): Query {
    return entity.kind === 'collection' ? firestore.collection(entity.path) : firestore.collectionGroup(entity.id);
  }

  /** collectionGroup trae todas las subcolecciones con ese nombre; solo cuentan las que cuelgan de la colección padre. */
  private belongs(document: QueryDocumentSnapshot | Record<string, unknown>, entity: FirestoreEntity): boolean {
    if (entity.kind === 'collection') return true;
    const path = document instanceof Object && 'ref' in document && document.ref && typeof (document.ref as { path?: unknown }).path === 'string'
      ? (document.ref as { path: string }).path
      : (document as Record<string, unknown>).__path;
    if (typeof path !== 'string') return false;
    const parts = path.split('/');
    return parts.length === 4 && parts[0] === entity.parent && parts[2] === entity.id;
  }

  private toRow(document: QueryDocumentSnapshot, entity: FirestoreEntity): Record<string, any> {
    const data = this.normalizeValue(document.data()) as Record<string, any>;
    const row: Record<string, any> = { ...data, [this.uniqueMetadataKey(data, '__documentId')]: document.id };
    if (entity.kind === 'group') {
      row[this.uniqueMetadataKey(row, '__parentId')] = document.ref.parent.parent?.id ?? null;
      row[this.uniqueMetadataKey(row, '__path')] = document.ref.path;
    }
    return row;
  }

  /** Solo condiciones de primer nivel que Firestore ejecuta (DataEngineService evalúa el resto en memoria). */
  private validateFilters(filters: readonly FilterNode[] | undefined): DataFilter[] {
    assertValidFilters(filters);
    return (filters ?? []).map((filter) => {
      if (isFilterGroup(filter) || !this.canPushDown(filter) || filter.campo.length > 1500) {
        throw new BadRequestException('El filtro de Firestore no es válido');
      }
      return filter;
    });
  }

  private applyFilter(query: Query, filter: DataFilter): Query {
    if (filter.operador === 'isNull') return query.where(filter.campo, filter.valor ? '==' : '!=', null);
    if (filter.operador === 'between') {
      const [min, max] = filter.valor as [string | number, string | number];
      return query.where(filter.campo, '>=', min).where(filter.campo, '<=', max);
    }
    return query.where(filter.campo, WHERE_FILTER_OPERATORS[filter.operador]!, filter.valor);
  }

  private uniqueMetadataKey(data: Record<string, any>, preferredKey: string): string {
    let key = preferredKey;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(data, key)) {
      key = `${preferredKey}_${suffix}`;
      suffix += 1;
    }
    return key;
  }

  private normalizeValue(value: unknown): any {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (Array.isArray(value)) return value.map((entry) => this.normalizeValue(entry));
    if (typeof value === 'object') {
      const record = value as Record<string, unknown> & {
        toDate?: () => Date;
        toBase64?: () => string;
        path?: string;
        latitude?: number;
        longitude?: number;
        get?: () => unknown;
      };
      if (typeof record.toDate === 'function') return record.toDate().toISOString();
      if (typeof record.toBase64 === 'function') return record.toBase64();
      if (typeof record.path === 'string' && typeof record.get === 'function') return record.path;
      if (typeof record.latitude === 'number' && typeof record.longitude === 'number') {
        return { latitude: record.latitude, longitude: record.longitude };
      }
      return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, this.normalizeValue(entry)]));
    }
    return value;
  }
}
