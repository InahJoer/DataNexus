import type { Provider } from '@nestjs/common';
import { AdapterRegistry } from './adapter-registry.js';
import { DATA_SOURCE_ADAPTERS, type IDataSourceAdapter } from './data-source-adapter.interface.js';
import { FirestoreAdapter } from './firestore.adapter.js';
import { MysqlAdapter } from './mysql.adapter.js';
import { PostgresAdapter } from './postgres.adapter.js';
import { SqlServerAdapter } from './sqlserver.adapter.js';

/**
 * Adaptadores registrados. Para agregar un motor: crear su clase IDataSourceAdapter y añadirla aquí;
 * DataEngineService no cambia.
 */
export const DATA_SOURCE_ADAPTER_CLASSES = [PostgresAdapter, MysqlAdapter, SqlServerAdapter, FirestoreAdapter];

/** Proveedores del registro de adaptadores (requieren DataSourcePoolModule). */
export const ADAPTER_PROVIDERS: Provider[] = [
  AdapterRegistry,
  ...DATA_SOURCE_ADAPTER_CLASSES,
  {
    provide: DATA_SOURCE_ADAPTERS,
    inject: DATA_SOURCE_ADAPTER_CLASSES,
    useFactory: (...adapters: IDataSourceAdapter[]) => adapters,
  },
];
