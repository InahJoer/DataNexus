'use client';

import { createContext, useContext } from 'react';
import type { components } from '@/lib/api/schema';

export type AuthUser = components['schemas']['AuthUserResponseDto'];
export type UserRole = AuthUser['role'];
export type LoginCredentials = components['schemas']['LoginDto'];
export type AuthSession = Readonly<{ accessToken: string; user: AuthUser }>;

export type AuthContextValue = Readonly<{
  session: AuthSession | null;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => void;
}>;

export const roleLabels: Record<UserRole, string> = {
  ADMIN: 'Administrador',
  OPERADOR: 'Operador',
  LECTOR: 'Lector',
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return context;
}
