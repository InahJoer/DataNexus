'use client';

import { useCallback } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { withSessionRetry, type ApiResult } from '@/lib/api/with-session-retry';
import { useAuth } from '@/lib/auth-context';

/** Para acciones (crear, editar, eliminar, probar): llama a la API con la sesión actual y el refresh transparente. */
export function useApiCall() {
  const { session, refreshSession } = useAuth();
  const token = session?.accessToken;
  return useCallback(
    <T,>(request: (api: ApiClient) => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
      if (!token) return Promise.reject(new Error('Sin sesión'));
      return withSessionRetry(token, refreshSession, request);
    },
    [token, refreshSession],
  );
}
