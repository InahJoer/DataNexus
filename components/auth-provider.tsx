'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { createApiClient } from '@/lib/api/client';
import { AuthContext, type AuthContextValue, type AuthSession, type LoginCredentials } from '@/lib/auth-context';

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

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [session, setSession] = useState<AuthSession | null>(null);

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

      setSession({ accessToken, user: profileResult.data });
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && /fetch failed|network/i.test(error.message))) {
        throw new Error('No se pudo conectar con DataNexus. Verifica que la API esté iniciada.');
      }
      throw error;
    }
  }, []);

  const logout = useCallback(() => setSession(null), []);
  const value = useMemo<AuthContextValue>(() => ({ session, login, logout }), [session, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
