export type CatalogObjectType = 'TABLE' | 'VIEW' | 'COLLECTION';

export interface CatalogObject {
  name: string;
  type: CatalogObjectType;
  schema?: string;
}

export interface DataExplorer {
  readonly tipoMotor: string;
  listObjects(connectionString: string, dbName: string): Promise<CatalogObject[]>;
  listFields?(connectionString: string, dbName: string, objectName: string, schema?: string): Promise<string[]>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export type DataExplorerFactory = (tipoMotor: string) => DataExplorer | undefined;

export const DATA_EXPLORER_FACTORY = Symbol('DATA_EXPLORER_FACTORY');
