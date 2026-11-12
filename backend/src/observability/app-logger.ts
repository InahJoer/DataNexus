import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { currentRequestId } from './request-context.js';

/** Campos que nunca deben aparecer en claro en los logs. */
export const REDACTED_LOG_FIELDS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  'privateKey',
  'private_key',
  'connectionString',
  'credentials',
];

type JsonLogOptions = Parameters<ConsoleLogger['getJsonLogObject']>[1];

/**
 * Logger de la aplicación (issue #51).
 * - En JSON (producción o LOG_FORMAT=json) cada línea es un objeto con `requestId`,
 *   de modo que todos los logs de una petición se pueden correlacionar.
 * - En texto (desarrollo) mantiene el formato legible de Nest y añade el requestId al contexto.
 */
export class AppLogger extends ConsoleLogger {
  protected override getJsonLogObject(message: unknown, options: JsonLogOptions) {
    const logObject = super.getJsonLogObject(message, options);
    const requestId = currentRequestId();
    return requestId ? { ...logObject, requestId } : logObject;
  }

  protected override formatContext(context: string): string {
    const requestId = currentRequestId();
    return super.formatContext(requestId ? `${context} ${requestId.slice(0, 8)}` : context);
  }
}

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/** Niveles activos a partir de LOG_LEVEL (por defecto `log`: fatal, error, warn y log). */
export function logLevelsFrom(level: string | undefined): LogLevel[] {
  const index = LOG_LEVELS.indexOf((level ?? 'log') as LogLevel);
  return LOG_LEVELS.slice(0, index === -1 ? LOG_LEVELS.indexOf('log') + 1 : index + 1);
}

export function createAppLogger(env: NodeJS.ProcessEnv = process.env): AppLogger {
  const json = env.LOG_FORMAT ? env.LOG_FORMAT === 'json' : env.NODE_ENV === 'production';
  return new AppLogger({
    json,
    colors: !json && env.NODE_ENV !== 'test',
    logLevels: logLevelsFrom(env.LOG_LEVEL),
    flattenParams: json,
    redact: REDACTED_LOG_FIELDS,
  });
}
