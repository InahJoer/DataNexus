'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createApiClient } from '@/lib/api/client';
import { useAuth } from '@/lib/auth-context';
import type { components } from '@/lib/api/schema';

type ConnectionHealthReport = components['schemas']['ConnectionHealthResponseDto'];

export function useConnectionHealth() {
  const { session, logout } = useAuth();
  const role = session?.user.role;
  const canCheckHealth = role === 'ADMIN' || role === 'OPERADOR';
  const router = useRouter();
  const [report, setReport] = useState<ConnectionHealthReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestInFlight = useRef(false);
  const hasReport = useRef(false);

  const refresh = useCallback(async () => {
    if (!canCheckHealth || !session?.accessToken || requestInFlight.current) return;

    requestInFlight.current = true;
    if (hasReport.current) setIsRefreshing(true);
    else setIsLoading(true);

    try {
      const result = await createApiClient(session.accessToken).GET('/engine/connections/health');
      if (result.response.status === 401) {
        logout();
        router.replace('/login');
        return;
      }
      if (!result.response.ok || !result.data) {
        setErrorMessage('No se pudo actualizar el estado de las conexiones.');
        return;
      }

      setReport(result.data);
      hasReport.current = true;
      setErrorMessage(null);
    } catch {
      setErrorMessage('No se pudo conectar con la API de DataNexus.');
    } finally {
      requestInFlight.current = false;
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [canCheckHealth, session?.accessToken, logout, router]);

  useEffect(() => {
    if (!canCheckHealth || !session?.accessToken) {
      setReport(null);
      hasReport.current = false;
      setErrorMessage(null);
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(interval);
  }, [canCheckHealth, session?.accessToken, refresh]);

  return { report, isLoading, isRefreshing, errorMessage, refresh };
}
