import type { Request } from 'express';
import type { UserRole } from './user-role.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  workspaceId: string;
  /** Sesión de la petición (sid del access token). Sirve para cerrar las demás y no la actual. */
  sessionId?: string;
}

export interface RequestAuditContext {
  ipAddress?: string;
  userAgent?: string;
}

export type AuthenticatedRequest = Request & { user: AuthenticatedUser };
