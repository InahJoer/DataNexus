import type { components } from '@/lib/api/schema';

export type Connection = components['schemas']['ConnectionResponseDto'];
export type Engine = Connection['tipoMotor'];
export type EngineKind = 'sql' | 'mongo' | 'firestore';

export const ENGINES: Record<Engine, { label: string; short: string; kind: EngineKind; port?: number; family: 'SQL' | 'NoSQL' }> = {
  POSTGRESQL: { label: 'PostgreSQL', short: 'PG', kind: 'sql', port: 5432, family: 'SQL' },
  MYSQL: { label: 'MySQL', short: 'MY', kind: 'sql', port: 3306, family: 'SQL' },
  SQLSERVER: { label: 'SQL Server', short: 'MS', kind: 'sql', port: 1433, family: 'SQL' },
  MONGODB: { label: 'MongoDB', short: 'MG', kind: 'mongo', family: 'NoSQL' },
  FIRESTORE: { label: 'Firestore', short: 'FB', kind: 'firestore', family: 'NoSQL' },
};

export const ENGINE_ORDER = Object.keys(ENGINES) as Engine[];
