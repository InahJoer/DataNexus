import { createApiClient, type ApiClient } from '@/lib/api/client';

export type ApiResult<T> = { data?: T; error?: unknown; response: Response };

/**
 * Refresh token transparente: si la API responde 401 (el access token venció antes de la renovación programada,
 * por ejemplo tras suspender el equipo), renueva la sesión y repite la petición una vez. Si la renovación falla,
 * devuelve el 401 original y la sesión ya quedó cerrada.
 */
export async function withSessionRetry<T>(
  accessToken: string,
  refreshSession: () => Promise<string | null>,
  request: (api: ApiClient) => Promise<ApiResult<T>>,
): Promise<ApiResult<T>> {
  const first = await request(createApiClient(accessToken));
  if (first.response.status !== 401) return first;
  const renewed = await refreshSession();
  return renewed ? request(createApiClient(renewed)) : first;
}
