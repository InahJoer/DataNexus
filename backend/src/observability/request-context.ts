import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Datos de la petición HTTP en curso, disponibles en cualquier punto de la cadena asíncrona (issue #51). */
export interface RequestContext {
  requestId: string;
}

export const REQUEST_ID_HEADER = 'x-request-id';

/** Solo se acepta un X-Request-Id entrante con formato seguro: evita inyectar texto arbitrario en los logs. */
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const storage = new AsyncLocalStorage<RequestContext>();

/** Ejecuta `callback` dentro del contexto de una petición. */
export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/** Identificador de la petición en curso, o `undefined` fuera de una petición (cron, colas, arranque). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Reutiliza el id que envía un proxy o el cliente si es válido; si no, genera uno nuevo. */
export function resolveRequestId(incoming: unknown): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return typeof value === 'string' && VALID_REQUEST_ID.test(value) ? value : randomUUID();
}
