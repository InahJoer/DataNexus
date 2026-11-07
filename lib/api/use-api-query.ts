'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createApiClient, type ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth-context';

type ApiResult<T> = { data?: T; error?: unknown; response: Response };

export type ApiQuery<T> = Readonly<{
  data: T | null;
  /** Mensaje listo para mostrar si la última petición falló. Se conservan los datos anteriores. */
  error: string | null;
  /** true solo en la primera carga; las recargas posteriores no vacían la pantalla. */
  isLoading: boolean;
  reload: () => Promise<void>;
}>;

/**
 * Petición GET autenticada con el manejo común de toda la app: estado de carga, mensaje de error legible y cierre
 * de sesión si la API responde 401. `request` debe ser estable (useCallback); con null no se pide nada (por ejemplo,
 * cuando el rol no tiene acceso).
 */
export function useApiQuery<T>(
  request: ((api: ApiClient) => Promise<ApiResult<T>>) | null,
  options: { refreshMs?: number } = {},
): ApiQuery<T> {
  const { session, logout } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(request !== null);
  // El token se lee de una ref: renovarlo (cada pocos minutos) no debe volver a pedir los datos.
  const tokenRef = useRef(session?.accessToken);
  useEffect(() => {
    tokenRef.current = session?.accessToken;
  }, [session?.accessToken]);
  const hasSession = Boolean(session);

  const load = useCallback(async () => {
    if (!request || !tokenRef.current) return;
    try {
      const result = await request(createApiClient(tokenRef.current));
      if (result.response.status === 401) {
        logout('expirada');
        router.replace('/login');
        return;
      }
      if (!result.response.ok || result.data === undefined) {
        setError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      setData(result.data);
      setError(null);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsLoading(false);
    }
  }, [request, logout, router]);

  useEffect(() => {
    if (!request || !hasSession) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void load();
    if (!options.refreshMs) return;
    const interval = window.setInterval(() => void load(), options.refreshMs);
    return () => window.clearInterval(interval);
  }, [request, hasSession, load, options.refreshMs]);

  return { data, error, isLoading, reload: load };
}
