export interface ConnectionPingResult {
  /** Versión legible del servidor, p. ej. "PostgreSQL 16.2". */
  serverVersion: string | null;
}

/**
 * Prueba de conectividad de un motor. Cada instancia se usa una sola vez:
 * `ping` abre la conexión, valida credenciales y base de datos, y `close`
 * libera recursos (también si `ping` sigue pendiente por timeout).
 */
export interface ConnectionTester {
  ping(connectionString: string, dbName: string, timeoutMs: number): Promise<ConnectionPingResult>;
  close(): Promise<void>;
}

export type ConnectionTesterFactory = (tipoMotor: string) => ConnectionTester | undefined;

export const CONNECTION_TESTER_FACTORY = Symbol('CONNECTION_TESTER_FACTORY');

/** Configuración inválida detectada antes de contactar al servidor. */
export class InvalidConnectionConfigError extends Error {
  readonly code = 'INVALID_CONFIGURATION';
}
