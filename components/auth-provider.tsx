'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApiClient } from '@/lib/api/client';
import {
  AuthContext,
  SESSION_IDLE_TIMEOUT_MS,
  rememberLogoutReason,
  type AuthContextValue,
  type AuthSession,
  type LoginCredentials,
  type LogoutReason,
} from '@/lib/auth-context';

/** Se renueva el access token este tiempo antes de que venza. */
const REFRESH_MARGIN_MS = 60_000;
const IDLE_CHECK_INTERVAL_MS = 30_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;

type TokenPair = { access_token: string; refresh_token: string; expires_in: number };

function getApiMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('message' in error)) return null;
  const message = error.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.filter((part): part is string => typeof part === 'string').join(' ');
  return null;
}

function apiError(error: unknown, status: number, fallback: string) {
  if (status === 401) return new Error('Correo o contraseña incorrectos.');
  return new Error(getApiMessage(error) ?? fallback);
}

const tokenFields = (tokens: TokenPair) => ({
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
  accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
});

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const sessionRef = useRef<AuthSession | null>(null);
  const lastInteractionRef = useRef(Date.now());
  const refreshInFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const login = useCallback(async (credentials: LoginCredentials) => {
    try {
      const loginResult = await createApiClient().POST('/auth/login', { body: credentials });
      if (!loginResult.response.ok || !loginResult.data) {
        throw apiError(loginResult.error, loginResult.response.status, 'No se pudo iniciar sesión.');
      }

      const accessToken = loginResult.data.access_token;
      const profileResult = await createApiClient(accessToken).GET('/auth/profile');
      if (!profileResult.response.ok || !profileResult.data) {
        throw apiError(profileResult.error, profileResult.response.status, 'No se pudo validar el perfil.');
      }
      if (profileResult.data.role !== loginResult.data.user.role) {
        throw new Error('El perfil recibido no coincide con el usuario autenticado.');
      }

      lastInteractionRef.current = Date.now();
      setSession({ ...tokenFields(loginResult.data), user: profileResult.data });
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && /fetch failed|network/i.test(error.message))) {
        throw new Error('No se pudo conectar con DataNexus. Verifica que la API esté iniciada.');
      }
      throw error;
    }
  }, []);

  const logout = useCallback((reason: LogoutReason = 'expirada') => {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    if (!current) return;

    rememberLogoutReason(reason);
    // Revoca la sesión en el servidor; si falla (red caída), el servidor la cerrará por inactividad.
    void createApiClient()
      // keepalive: la petición sobrevive aunque la página navegue a /login en ese momento.
      .POST('/auth/logout', { body: { refresh_token: current.refreshToken }, keepalive: true })
      .catch(() => undefined);
  }, []);

  /** Renueva el par de tokens. Una sola renovación a la vez: el backend trata dos simultáneas como robo. */
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;

    const run = async () => {
      const current = sessionRef.current;
      if (!current) return;
      try {
        const result = await createApiClient().POST('/auth/refresh', {
          body: { refresh_token: current.refreshToken },
        });
        if (!result.response.ok || !result.data) {
          if (result.response.status === 401) logout('expirada');
          return;
        }
        const tokens = result.data;
        setSession((previous) => (previous ? { ...previous, ...tokenFields(tokens) } : previous));
      } catch {
        // Error de red: se reintenta en el próximo ciclo; el access token aún puede ser válido.
      }
    };

    refreshInFlight.current = run().finally(() => {
      refreshInFlight.current = null;
    });
    return refreshInFlight.current;
  }, [logout]);

  // Registro de actividad del usuario en la página.
  useEffect(() => {
    if (!session) return;
    const markActivity = () => {
      lastInteractionRef.current = Date.now();
    };
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, markActivity, { passive: true });
    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, markActivity);
    };
  }, [session]);

  // Cierre por inactividad (RF-04): también se revisa al volver a la pestaña tras suspender el equipo.
  useEffect(() => {
    if (!session) return;
    const checkIdle = () => {
      if (Date.now() - lastInteractionRef.current > SESSION_IDLE_TIMEOUT_MS) logout('inactividad');
    };
    const interval = window.setInterval(checkIdle, IDLE_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkIdle();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, logout]);

  // Renovación del access token antes de que venza, solo si el usuario sigue activo.
  const accessTokenExpiresAt = session?.accessTokenExpiresAt;
  useEffect(() => {
    if (!accessTokenExpiresAt) return;
    const delay = Math.max(accessTokenExpiresAt - Date.now() - REFRESH_MARGIN_MS, 0);
    const timer = window.setTimeout(() => {
      if (Date.now() - lastInteractionRef.current > SESSION_IDLE_TIMEOUT_MS) {
        logout('inactividad');
      } else {
        void refresh();
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [accessTokenExpiresAt, logout, refresh]);

  const value = useMemo<AuthContextValue>(() => ({ session, login, logout }), [session, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
