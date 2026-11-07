'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApiClient } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/errors';
import {
  AuthContext,
  IDLE_WARNING_MS,
  SESSION_IDLE_TIMEOUT_MS,
  rememberLogoutReason,
  type AuthContextValue,
  type AuthSession,
  type AuthStatus,
  type LoginCredentials,
  type LoginOptions,
  type LogoutReason,
} from '@/lib/auth-context';
import {
  SESSION_STORAGE_KEY,
  clearStoredSession,
  loadStoredSession,
  parseStoredToken,
  storeSession,
  withRefreshLock,
} from '@/lib/session-storage';
import type { components } from '@/lib/api/schema';

/** Se renueva el access token este tiempo antes de que venza. */
const REFRESH_MARGIN_MS = 60_000;
const IDLE_TICK_MS = 1_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;

type AuthResponse = components['schemas']['AuthResponseDto'];

/** Error de login con el código HTTP, para que el formulario marque el campo (401) o muestre el bloqueo (423). */
export class LoginError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'LoginError';
  }
}

function loginError(error: unknown, status: number) {
  if (status === 401) return new LoginError('Correo o contraseña incorrectos. Revisa tus credenciales.', status);
  return new LoginError(apiErrorMessage(error, status), status);
}

const tokenFields = (tokens: Pick<AuthResponse, 'access_token' | 'refresh_token' | 'expires_in'>) => ({
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
  accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
});

/**
 * Recupera la sesión guardada una sola vez por carga de página. Vive fuera del componente porque React (modo
 * estricto) monta los efectos dos veces en desarrollo y el backend trata dos usos del mismo refresh token como robo.
 */
let restoreOnce: Promise<{ session: AuthSession; remember: boolean } | null> | null = null;

function restoreStoredSession() {
  restoreOnce ??= withRefreshLock(async () => {
    const stored = loadStoredSession();
    if (!stored) return null;
    try {
      const result = await createApiClient().POST('/auth/refresh', { body: { refresh_token: stored.refreshToken } });
      if (!result.response.ok || !result.data) {
        if (result.response.status === 401) clearStoredSession(stored.remember);
        return null;
      }
      const session: AuthSession = { ...tokenFields(result.data), user: result.data.user };
      storeSession(session.refreshToken, session.user.id, stored.remember);
      return { session, remember: stored.remember };
    } catch {
      return null;
    }
  });
  return restoreOnce;
}

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [idleSecondsLeft, setIdleSecondsLeft] = useState<number | null>(null);
  const sessionRef = useRef<AuthSession | null>(null);
  const rememberRef = useRef(false);
  const lastInteractionRef = useRef(Date.now());
  const refreshInFlight = useRef<Promise<string | null> | null>(null);

  const applySession = useCallback((next: AuthSession | null) => {
    sessionRef.current = next;
    setSession(next);
    setStatus(next ? 'authenticated' : 'anonymous');
    if (next) storeSession(next.refreshToken, next.user.id, rememberRef.current);
  }, []);

  // Recarga de página: se intenta recuperar la sesión con el refresh token guardado.
  useEffect(() => {
    let active = true;
    void restoreStoredSession().then((restored) => {
      if (!active || sessionRef.current) return;
      if (restored) {
        rememberRef.current = restored.remember;
        lastInteractionRef.current = Date.now();
      }
      applySession(restored?.session ?? null);
    });
    return () => {
      active = false;
    };
  }, [applySession]);

  const login = useCallback(
    async (credentials: LoginCredentials, options: LoginOptions = {}) => {
      try {
        const loginResult = await createApiClient().POST('/auth/login', { body: credentials });
        if (!loginResult.response.ok || !loginResult.data) {
          throw loginError(loginResult.error, loginResult.response.status);
        }

        const accessToken = loginResult.data.access_token;
        const profileResult = await createApiClient(accessToken).GET('/auth/profile');
        if (!profileResult.response.ok || !profileResult.data) {
          throw loginError(profileResult.error, profileResult.response.status);
        }
        if (profileResult.data.role !== loginResult.data.user.role) {
          throw new LoginError('El perfil recibido no coincide con el usuario autenticado.', null);
        }

        rememberRef.current = Boolean(options.remember);
        lastInteractionRef.current = Date.now();
        applySession({ ...tokenFields(loginResult.data), user: profileResult.data });
      } catch (error) {
        if (error instanceof LoginError) throw error;
        throw new LoginError('No se pudo conectar con DataNexus. Verifica que la API esté iniciada.', null);
      }
    },
    [applySession],
  );

  const logout = useCallback(
    (reason: LogoutReason = 'expirada') => {
      const current = sessionRef.current;
      applySession(null);
      clearStoredSession(rememberRef.current);
      setIdleSecondsLeft(null);
      if (!current) return;

      rememberLogoutReason(reason);
      // Revoca la sesión en el servidor; si falla (red caída), el servidor la cerrará por inactividad.
      void createApiClient()
        // keepalive: la petición sobrevive aunque la página navegue a /login en ese momento.
        .POST('/auth/logout', { body: { refresh_token: current.refreshToken }, keepalive: true })
        .catch(() => undefined);
    },
    [applySession],
  );

  /** Renueva el par de tokens. Una sola renovación a la vez: el backend trata dos simultáneas como robo. */
  const refreshSession = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;

    const run = (): Promise<string | null> => withRefreshLock(async () => {
      const current = sessionRef.current;
      if (!current) return null;
      // Con "mantener sesión", otra pestaña pudo rotar el token mientras se esperaba el lock: se usa el último guardado.
      const stored = rememberRef.current ? loadStoredSession() : null;
      const refreshToken = stored?.remember && stored.userId === current.user.id ? stored.refreshToken : current.refreshToken;
      try {
        const result = await createApiClient().POST('/auth/refresh', {
          body: { refresh_token: refreshToken },
        });
        if (!result.response.ok || !result.data) {
          if (result.response.status === 401) logout('expirada');
          return null;
        }
        // Si mientras tanto se cerró la sesión, no se revive.
        if (!sessionRef.current) return null;
        // Defensa extra: nunca se cambia de identidad en silencio.
        if (result.data.user.id !== current.user.id) {
          logout('expirada');
          return null;
        }
        const next = { ...sessionRef.current, ...tokenFields(result.data) };
        applySession(next);
        return next.accessToken;
      } catch {
        // Error de red: se reintenta en el próximo ciclo; el access token aún puede ser válido.
        return null;
      }
    });

    refreshInFlight.current = run().finally(() => {
      refreshInFlight.current = null;
    });
    return refreshInFlight.current;
  }, [applySession, logout]);

  // Otras pestañas con "mantener sesión": adoptan el token que otra rotó y cierran sesión si otra la cerró.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_KEY || event.storageArea !== localStorage || !rememberRef.current) return;
      const current = sessionRef.current;
      // Solo cuenta si el cambio viene de esta misma sesión (el valor anterior era nuestro token).
      if (!current || parseStoredToken(event.oldValue)?.refreshToken !== current.refreshToken) return;
      const next = parseStoredToken(event.newValue);
      if (!next) {
        // La API ya revocó la sesión desde la otra pestaña: aquí solo se limpia el estado local.
        rememberLogoutReason('manual');
        applySession(null);
        setIdleSecondsLeft(null);
      } else if (next.userId === current.user.id && next.refreshToken !== current.refreshToken) {
        sessionRef.current = { ...current, refreshToken: next.refreshToken };
        setSession(sessionRef.current);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [applySession]);

  const stayActive = useCallback(() => {
    lastInteractionRef.current = Date.now();
    setIdleSecondsLeft(null);
  }, []);

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

  // Aviso y cierre por inactividad (RF-04). El intervalo también detecta el regreso tras suspender el equipo.
  const isAuthenticated = session !== null;
  useEffect(() => {
    if (!isAuthenticated) return;
    const tick = () => {
      const idleFor = Date.now() - lastInteractionRef.current;
      if (idleFor >= SESSION_IDLE_TIMEOUT_MS) {
        logout('inactividad');
        return;
      }
      const left = SESSION_IDLE_TIMEOUT_MS - idleFor;
      setIdleSecondsLeft(left <= IDLE_WARNING_MS ? Math.ceil(left / 1000) : null);
    };
    const interval = window.setInterval(tick, IDLE_TICK_MS);
    return () => window.clearInterval(interval);
  }, [isAuthenticated, logout]);

  // Renovación del access token antes de que venza, solo si el usuario sigue activo.
  const accessTokenExpiresAt = session?.accessTokenExpiresAt;
  useEffect(() => {
    if (!accessTokenExpiresAt) return;
    const delay = Math.max(accessTokenExpiresAt - Date.now() - REFRESH_MARGIN_MS, 0);
    const timer = window.setTimeout(() => {
      if (Date.now() - lastInteractionRef.current >= SESSION_IDLE_TIMEOUT_MS) {
        logout('inactividad');
      } else {
        void refreshSession();
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [accessTokenExpiresAt, logout, refreshSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, status, login, logout, refreshSession, idleSecondsLeft, stayActive }),
    [session, status, login, logout, refreshSession, idleSecondsLeft, stayActive],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
