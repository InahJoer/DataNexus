import createClient from 'openapi-fetch';
import type { paths } from './schema';

/**
 * URL de la API. Si NEXT_PUBLIC_API_URL no está definida, se usa el mismo host desde el que se abrió la app en el
 * puerto 3001: así funciona igual en http://localhost:3000 que en http://192.168.1.18:3000 desde otro equipo.
 */
export const apiBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:3001` : 'http://localhost:3001')
).replace(/\/$/, '');

export function createApiClient(accessToken?: string) {
  return createClient<paths>({
    baseUrl: apiBaseUrl,
    ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
