'use client';

import { createContext, useContext } from 'react';
import type { components } from '@/lib/api/schema';

export type AuthUser = components['schemas']['AuthUserResponseDto'];
export type UserRole = AuthUser['role'];
export type LoginCredentials = components['schemas']['LoginDto'];
export type AuthSession = Readonly<{
  accessToken: string;
  refreshToken: string;
  /** Momento (ms) en que vence el access token. */
  accessTokenExpiresAt: number;
  user: AuthUser;
}>;

/** Por qué se cerró la sesión; la pantalla de login lo muestra al usuario. */
export type LogoutReason = 'manual' | 'inactividad' | 'expirada';

/**
 * restoring: al abrir la app se intenta recuperar la sesión guardada (recarga de página o "mantener sesión").
 * Mientras tanto las pantallas protegidas no deben redirigir al login.
 */
export type AuthStatus = 'restoring' | 'authenticated' | 'anonymous';

export type LoginOptions = Readonly<{
  /** "Mantener sesión en este dispositivo": la sesión sobrevive al cerrar el navegador. */
  remember?: boolean;
}>;

export type AuthContextValue = Readonly<{
  session: AuthSession | null;
  status: AuthStatus;
  login: (credentials: LoginCredentials, options?: LoginOptions) => Promise<void>;
  /** Cierra la sesión en la API y en el navegador. Sin motivo se asume que expiró (401). */
  logout: (reason?: LogoutReason) => void;
  /**
   * Renueva el par de tokens (por ejemplo, tras un 401 inesperado). Devuelve el nuevo access token, o null si la
   * sesión ya no es válida; en ese caso la sesión queda cerrada.
   */
  refreshSession: () => Promise<string | null>;
  /** Segundos que faltan para el cierre por inactividad cuando ya se está avisando; null si no hay aviso. */
  idleSecondsLeft: number | null;
  /** "Seguir conectado": cuenta como actividad y oculta el aviso. */
  stayActive: () => void;
}>;

/** Debe coincidir con SESSION_IDLE_TIMEOUT_MINUTES del backend (RF-04). */
export const SESSION_IDLE_TIMEOUT_MS =
  (Number(process.env.NEXT_PUBLIC_SESSION_IDLE_MINUTES) || 30) * 60_000;

/** Antes del cierre por inactividad se avisa con este margen. */
export const IDLE_WARNING_MS = Math.min(2 * 60_000, SESSION_IDLE_TIMEOUT_MS / 2);

const LOGOUT_REASON_KEY = 'datanexus:logout-reason';

export function rememberLogoutReason(reason: LogoutReason) {
  try {
    sessionStorage.setItem(LOGOUT_REASON_KEY, reason);
  } catch {
    // Sin sessionStorage (modo privado estricto) simplemente no se muestra el aviso.
  }
}

export function takeLogoutReason(): LogoutReason | null {
  try {
    const value = sessionStorage.getItem(LOGOUT_REASON_KEY);
    sessionStorage.removeItem(LOGOUT_REASON_KEY);
    return value === 'manual' || value === 'inactividad' || value === 'expirada' ? value : null;
  } catch {
    return null;
  }
}

export const roleLabels: Record<UserRole, string> = {
  ADMIN: 'Administrador',
  OPERADOR: 'Operador',
  LECTOR: 'Lector',
  AUDITOR: 'Auditor de TI',
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return context;
}
