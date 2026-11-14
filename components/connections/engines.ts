import type { components } from '@/lib/api/schema';

export type Connection = components['schemas']['ConnectionResponseDto'];
export type Engine = Connection['tipoMotor'];
/** Motores de las fuentes: los de las conexiones y EXCEL (archivos subidos, que se exploran y cruzan igual). */
export type SourceEngine = Engine | 'EXCEL';
export type EngineKind = 'sql' | 'mongo' | 'firestore' | 'sheet';

/** Lo que el explorador y el editor necesitan de una fuente: una conexión o un archivo de Excel (su id es el conexionId). */
export type DataSource = Readonly<{ id: string; nombre?: string | null; dbName: string; tipoMotor: SourceEngine }>;

export const ENGINES: Record<SourceEngine, { label: string; short: string; kind: EngineKind; port?: number; family: 'SQL' | 'NoSQL' | 'Archivo' }> = {
  POSTGRESQL: { label: 'PostgreSQL', short: 'PG', kind: 'sql', port: 5432, family: 'SQL' },
  MYSQL: { label: 'MySQL', short: 'MY', kind: 'sql', port: 3306, family: 'SQL' },
  SQLSERVER: { label: 'SQL Server', short: 'MS', kind: 'sql', port: 1433, family: 'SQL' },
  MONGODB: { label: 'MongoDB', short: 'MG', kind: 'mongo', family: 'NoSQL' },
  FIRESTORE: { label: 'Firestore', short: 'FB', kind: 'firestore', family: 'NoSQL' },
  EXCEL: { label: 'Excel', short: 'XL', kind: 'sheet', family: 'Archivo' },
};

/** Motores que se pueden elegir al crear una conexión (Excel se sube desde el explorador). */
export const ENGINE_ORDER = (Object.keys(ENGINES) as SourceEngine[]).filter((engine): engine is Engine => engine !== 'EXCEL');
