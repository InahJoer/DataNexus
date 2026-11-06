import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { Firestore, type Query, type WhereFilterOp } from '@google-cloud/firestore';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';
import {
  EXTERNAL_QUERY_TIMEOUT_MS,
  getJsonByteLength,
  getMaxSourceBytes,
  getMaxSourceRows,
} from '../data-engine.constants.js';
import { FILTER_OPERATORS, type DataFilter, type FilterOperator } from '../dto/cross-join.dto.js';
import type {
  CatalogObject,
  DataSourceConnection,
  ExtractOptions,
  IDataSourceAdapter,
} from './data-source-adapter.interface.js';
import { isScalarFilterValue } from './sql-filters.js';

const WHERE_FILTER_OPERATORS: Record<FilterOperator, WhereFilterOp> = {
  eq: '==',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  in: 'in',
  'not-in': 'not-in',
};

interface FirestoreServiceAccount {
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
}

/** Firestore: colecciones raíz, campos por muestreo y extracción con filtros, con un cliente reutilizable. */
@Injectable()
export class FirestoreAdapter implements IDataSourceAdapter {
  readonly tipoMotor = 'FIRESTORE' as const;
  readonly capabilities = { explore: true, fields: true, extract: true };

  constructor(private readonly clients: DataSourceClientPool) {}

  listObjects(connection: DataSourceConnection): Promise<CatalogObject[]> {
    return this.withClient(connection, async (firestore) => {
      const collections = await firestore.listCollections();
      return collections.map((collection) => ({ name: collection.id, type: 'COLLECTION' as const }));
    });
  }

  /** Campos del primer documento de la colección (Firestore no tiene esquema). */
  async listFields(connection: DataSourceConnection, collectionName: string): Promise<string[]> {
    this.validateCollectionName(collectionName);
    return await this.withClient(connection, async (firestore) => {
      const snapshot = await firestore.collection(collectionName).limit(1).get();
      if (snapshot.empty) return [];
      return Object.keys(snapshot.docs[0].data() ?? {});
    });
  }

  async extract(
    connection: DataSourceConnection,
    collectionName: string,
    options: ExtractOptions = {},
  ): Promise<Record<string, any>[]> {
    this.validateCollectionName(collectionName);
    for (const filter of options.filters ?? []) this.validateFilter(filter);
    const maxRows = getMaxSourceRows();
    const maxBytes = getMaxSourceBytes();

    return await this.withClient(connection, async (firestore) => {
      let query: Query = firestore.collection(collectionName);
      for (const filter of options.filters ?? []) {
        query = query.where(filter.campo, WHERE_FILTER_OPERATORS[filter.operador], filter.valor);
      }
      const stream = query.limit(maxRows + 1).stream() as NodeJS.ReadableStream & { destroy(error?: Error): unknown };
      const timeout = setTimeout(
        () => stream.destroy(Object.assign(new Error('Firestore query timeout'), { code: 'DEADLINE_EXCEEDED' })),
        EXTERNAL_QUERY_TIMEOUT_MS,
      );
      timeout.unref?.();

      try {
        const rows: Record<string, any>[] = [];
        let totalBytes = 0;
        for await (const document of stream as AsyncIterable<any>) {
          if (rows.length >= maxRows) {
            throw new PayloadTooLargeException(`La colección supera el máximo de ${maxRows} documentos configurado`);
          }
          const data = this.normalizeValue(document.data()) as Record<string, any>;
          const documentIdKey = this.uniqueMetadataKey(data, '__documentId');
          const row = { ...data, [documentIdKey]: document.id };
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

  private validateCollectionName(collectionName: string): void {
    if (!collectionName || collectionName.length > 150 || collectionName.includes('/')) {
      throw new BadRequestException('Solo se admiten colecciones raíz con nombre válido');
    }
  }

  private validateFilter(filter: DataFilter): void {
    if (
      !filter ||
      typeof filter.campo !== 'string' ||
      !filter.campo.trim() ||
      filter.campo.length > 150 ||
      !FILTER_OPERATORS.includes(filter.operador)
    ) {
      throw new BadRequestException('El filtro de Firestore no es válido');
    }
    if (filter.operador === 'in' || filter.operador === 'not-in') {
      if (
        !Array.isArray(filter.valor) ||
        filter.valor.length === 0 ||
        filter.valor.length > 10 ||
        filter.valor.some((value) => value === null || !isScalarFilterValue(value))
      ) {
        throw new BadRequestException('El valor del filtro de Firestore no es válido');
      }
      return;
    }
    if (
      filter.valor === undefined ||
      (filter.valor === null && filter.operador !== 'eq' && filter.operador !== 'neq') ||
      (filter.valor !== null && !isScalarFilterValue(filter.valor))
    ) {
      throw new BadRequestException('El valor del filtro de Firestore no es válido');
    }
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
