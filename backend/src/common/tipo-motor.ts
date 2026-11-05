/** Motores soportados. Debe coincidir con el enum TipoMotor de prisma/schema.prisma. */
export const TIPOS_MOTOR = ['POSTGRESQL', 'MYSQL', 'SQLSERVER', 'FIRESTORE', 'MONGODB'] as const;

export type TipoMotor = (typeof TIPOS_MOTOR)[number];

/** Alias aceptados en la API (sin distinguir mayúsculas, espacios ni guiones). */
const ALIASES: Record<string, TipoMotor> = {
  postgresql: 'POSTGRESQL',
  postgres: 'POSTGRESQL',
  pg: 'POSTGRESQL',
  mysql: 'MYSQL',
  mariadb: 'MYSQL',
  sqlserver: 'SQLSERVER',
  mssql: 'SQLSERVER',
  firestore: 'FIRESTORE',
  firebase: 'FIRESTORE',
  cloudfirestore: 'FIRESTORE',
  mongodb: 'MONGODB',
  mongo: 'MONGODB',
};

/**
 * Convierte cualquier alias conocido ("SQL Server", "Firebase", "postgres"...) al valor canónico.
 * Devuelve el valor original si no es reconocido para que la validación lo rechace.
 */
export function normalizeTipoMotor(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return ALIASES[value.toLowerCase().replace(/[^a-z]/g, '')] ?? value;
}

export const TIPO_MOTOR_MESSAGE = `El tipo de motor debe ser uno de: ${TIPOS_MOTOR.join(', ')}`;
