import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { MongoClient, type Document } from 'mongodb';
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
import { assertMongoCollectionName, buildMongoFilter } from './mongo-filters.js';

/** Documentos que se leen para inferir los campos de una colección (MongoDB no tiene esquema). */
export const MONGO_FIELD_SAMPLE_SIZE = 100;

/**
 * Convierte los tipos BSON a valores JSON legibles y estables para el cross-join y la exportación:
 * ObjectId → hex, Decimal128/Long → número (o texto si no cabe sin perder precisión), Binary → base64
 * (UUID → texto), Date → ISO 8601. Así una llave `_id` de MongoDB se puede cruzar con una columna SQL de texto.
 */
export function normalizeBsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => normalizeBsonValue(entry));
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value !== 'object') return value;

  // Todos los tipos BSON implementan toString() con una representación legible.
  const bson = value as { _bsontype?: string; toString(): string } & Record<string, any>;
  switch (bson._bsontype) {
    case 'ObjectId':
    case 'ObjectID':
      return bson.toHexString();
    case 'Decimal128': {
      const text = bson.toString() as string;
      const number = Number(text);
      return Number.isFinite(number) && String(number) === text ? number : text;
    }
    case 'Long': {
      const number = bson.toNumber() as number;
      return Number.isSafeInteger(number) ? number : bson.toString();
    }
    case 'Int32':
    case 'Double':
      return bson.valueOf();
    case 'Binary':
      return bson.sub_type === 4 ? bson.toUUID().toString() : Buffer.from(bson.buffer as Uint8Array).toString('base64');
    case 'UUID':
      return bson.toString();
    case 'Timestamp':
      return { t: bson.t, i: bson.i };
    case 'BSONRegExp':
      return `/${bson.pattern}/${bson.options}`;
    case 'Code':
      return bson.code;
    case 'MinKey':
    case 'MaxKey':
    case 'BSONSymbol':
    case 'DBRef':
      return bson.toString();
    default:
      break;
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return Object.fromEntries(Object.entries(bson).map(([key, entry]) => [key, normalizeBsonValue(entry)]));
}

/** MongoDB: colecciones y vistas de la base configurada, campos por muestreo y extracción con filter pushdown. */
@Injectable()
export class MongoDbAdapter implements IDataSourceAdapter {
  readonly tipoMotor = 'MONGODB' as const;
  readonly capabilities = { explore: true, fields: true, extract: true };

  constructor(private readonly clients: DataSourceClientPool) {}

  listObjects(connection: DataSourceConnection): Promise<CatalogObject[]> {
    return this.withClient(connection, async (client) => {
      const collections = await client
        .db(connection.dbName)
        .listCollections({}, { nameOnly: false, authorizedCollections: true })
        .toArray();
      return collections
        .filter((collection) => !collection.name.startsWith('system.'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((collection) => ({
          name: collection.name,
          schema: connection.dbName,
          type: collection.type === 'view' ? ('VIEW' as const) : ('COLLECTION' as const),
        }));
    });
  }

  /**
   * Campos inferidos de una muestra aleatoria de documentos: unión de las claves de primer nivel, en el orden
   * en que aparecen (`_id` primero). Una colección vacía no tiene campos.
   */
  async listFields(connection: DataSourceConnection, collectionName: string): Promise<string[]> {
    assertMongoCollectionName(collectionName);
    return await this.withClient(connection, async (client) => {
      const sample = await client
        .db(connection.dbName)
        .collection(collectionName)
        .aggregate<Document>([{ $sample: { size: MONGO_FIELD_SAMPLE_SIZE } }], { maxTimeMS: EXTERNAL_QUERY_TIMEOUT_MS })
        .toArray();
      const fields = new Set<string>();
      for (const document of sample) for (const key of Object.keys(document)) fields.add(key);
      return [...fields].sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
    });
  }

  async extract(
    connection: DataSourceConnection,
    collectionName: string,
    options: ExtractOptions = {},
  ): Promise<Record<string, any>[]> {
    assertMongoCollectionName(collectionName);
    const filter = buildMongoFilter(options.filters ?? []);
    const maxRows = getMaxSourceRows();
    const maxBytes = getMaxSourceBytes();

    return await this.withClient(connection, async (client) => {
      const cursor = client
        .db(connection.dbName)
        .collection(collectionName)
        .find(filter, { limit: maxRows + 1, maxTimeMS: EXTERNAL_QUERY_TIMEOUT_MS, batchSize: 500 });

      const rows: Record<string, any>[] = [];
      let totalBytes = 0;
      try {
        for await (const document of cursor) {
          if (rows.length >= maxRows) {
            throw new PayloadTooLargeException(`La colección supera el máximo de ${maxRows} documentos configurado`);
          }
          const row = normalizeBsonValue(document) as Record<string, any>;
          const rowBytes = getJsonByteLength(row);
          if (totalBytes + rowBytes > maxBytes) {
            throw new PayloadTooLargeException(`La colección supera el máximo de ${maxBytes} bytes configurado`);
          }
          totalBytes += rowBytes;
          rows.push(row);
        }
        return rows;
      } finally {
        await cursor.close().catch(() => undefined);
      }
    });
  }

  private withClient<R>(connection: DataSourceConnection, use: (client: MongoClient) => Promise<R>): Promise<R> {
    return this.clients.withClient(
      { connectionId: connection.id, connectionString: connection.connectionString, variant: connection.dbName },
      async () => this.createClient(connection),
      (client) => client.close(),
      use,
    );
  }

  private async createClient(connection: DataSourceConnection): Promise<MongoClient> {
    if (!/^mongodb(\+srv)?:\/\//.test(connection.connectionString)) {
      throw new BadRequestException('La URI de MongoDB debe empezar por mongodb:// o mongodb+srv://');
    }
    if (!connection.dbName) throw new BadRequestException('La conexión de MongoDB no indica la base de datos');

    const client = new MongoClient(connection.connectionString, {
      appName: 'DataNexus',
      serverSelectionTimeoutMS: EXTERNAL_QUERY_TIMEOUT_MS,
      connectTimeoutMS: EXTERNAL_QUERY_TIMEOUT_MS,
      socketTimeoutMS: EXTERNAL_QUERY_TIMEOUT_MS * 2,
      maxPoolSize: 4,
      maxIdleTimeMS: 60_000,
      retryWrites: false,
    });
    try {
      await client.connect();
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return client;
  }
}
