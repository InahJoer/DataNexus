import type { TipoMotor } from '../../common/tipo-motor.js';
import type { DataFilter, FilterNode } from '../filters/filter-tree.js';

export type CatalogObjectType = 'TABLE' | 'VIEW' | 'COLLECTION';

export interface CatalogObject {
  name: string;
  type: CatalogObjectType;
  schema?: string;
}

/**
 * Conexión lista para el driver: credenciales ya descifradas y traducidas al formato del motor
 * (ConnectionsService.getConnectionForExploration). Nunca debe salir del backend.
 */
export interface DataSourceConnection {
  id: string;
  tipoMotor: string;
  dbName: string;
  connectionString: string;
}

export interface ExtractOptions {
  schema?: string;
  /** Filtros que el adaptador debe aplicar en el motor (ya validados; solo los que declara en canPushDown). */
  filters?: FilterNode[];
}

/** Qué operaciones implementa un adaptador. */
export interface DataSourceCapabilities {
  /** Listar tablas, vistas o colecciones. */
  explore: boolean;
  /** Listar los campos de una tabla o colección. */
  fields: boolean;
  /** Extraer registros para cross-joins y exportaciones. */
  extract: boolean;
}

/**
 * Contrato único de una fuente de datos externa (Adapter Pattern, RNF-10). DataEngineService solo conoce esta
 * interfaz: agregar un motor = crear un adaptador y registrarlo en DATA_SOURCE_ADAPTERS.
 *
 * Los adaptadores no guardan estado por conexión: piden sus clientes a DataSourceClientPool, que los reutiliza,
 * los cierra por inactividad y los invalida al editar o eliminar la conexión.
 */
export interface IDataSourceAdapter {
  readonly tipoMotor: TipoMotor;
  readonly capabilities: DataSourceCapabilities;
  listObjects(connection: DataSourceConnection): Promise<CatalogObject[]>;
  listFields(connection: DataSourceConnection, objectName: string, schema?: string): Promise<string[]>;
  extract(connection: DataSourceConnection, entityName: string, options?: ExtractOptions): Promise<Record<string, any>[]>;
  /**
   * Si el motor puede ejecutar esta condición (filter pushdown). Sin implementar = todas. Lo que no se puede
   * ejecutar en el motor lo evalúa DataEngineService en memoria tras la extracción.
   */
  canPushDown?(filter: DataFilter): boolean;
  /** Si el motor puede ejecutar grupos AND/OR anidados. Sin declarar = sí. */
  readonly pushesFilterGroups?: boolean;
}

/** Token de inyección con la lista de adaptadores registrados. */
export const DATA_SOURCE_ADAPTERS = Symbol('DATA_SOURCE_ADAPTERS');

/** Error para operaciones que un motor no implementa (se traduce a 400). */
export class UnsupportedOperationError extends Error {
  readonly code = 'UNSUPPORTED_OPERATION';
}
