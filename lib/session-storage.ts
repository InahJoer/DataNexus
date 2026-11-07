/**
 * Dónde se guarda el refresh token para recuperar la sesión al recargar la página.
 * - Sin "mantener sesión": sessionStorage (dura lo que la pestaña).
 * - Con "mantener sesión": localStorage (sobrevive al cerrar el navegador y lo comparten las pestañas).
 * El access token nunca se guarda: vive solo en memoria y se obtiene de nuevo con el refresh token, que el backend
 * rota en cada uso y revoca entero si detecta que se reutilizó.
 */
export const SESSION_STORAGE_KEY = 'datanexus:session';
const KEY = SESSION_STORAGE_KEY;

export type StoredToken = { refreshToken: string; userId: string | null };
export type StoredSession = StoredToken & { remember: boolean };

/** Valor guardado (también sirve para leer el evento `storage` de otras pestañas). */
export function parseStoredToken(raw: string | null): StoredToken | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'refreshToken' in value && typeof value.refreshToken === 'string') {
      const userId = 'userId' in value && typeof value.userId === 'string' ? value.userId : null;
      return { refreshToken: value.refreshToken, userId };
    }
  } catch {
    // JSON dañado: se trata como si no hubiera sesión.
  }
  return null;
}

function read(storage: Storage): StoredSession | null {
  try {
    const token = parseStoredToken(storage.getItem(KEY));
    return token ? { ...token, remember: storage === localStorage } : null;
  } catch {
    // Almacenamiento bloqueado: se trata como si no hubiera sesión.
    return null;
  }
}

/**
 * Las pestañas con "mantener sesión" comparten el refresh token. Como el backend lo rota en cada uso y revoca la
 * sesión si ve uno ya usado, las renovaciones se hacen de una en una entre pestañas (Web Locks) y con el último
 * token guardado de la misma cuenta.
 */
export async function withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('datanexus:refresh', task);
  }
  return task();
}

export function loadStoredSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  return read(sessionStorage) ?? read(localStorage);
}

export function storeSession(refreshToken: string, userId: string, remember: boolean) {
  try {
    // Una sesión sin "mantener" no toca localStorage: ahí puede estar la sesión recordada de otra pestaña.
    if (remember) sessionStorage.removeItem(KEY);
    (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify({ refreshToken, userId }));
  } catch {
    // Sin almacenamiento la sesión sigue funcionando, solo que no sobrevive a una recarga.
  }
}

/** Borra la sesión guardada de esta pestaña; la de localStorage solo si era la recordada (remember). */
export function clearStoredSession(remember: boolean) {
  try {
    sessionStorage.removeItem(KEY);
    if (remember) localStorage.removeItem(KEY);
  } catch {
    // Nada que limpiar.
  }
}
