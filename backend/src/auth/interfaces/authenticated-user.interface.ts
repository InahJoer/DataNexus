import type { Request } from 'express';
import type { Permission, UserRole } from './user-role.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  workspaceId: string;
  /** Sesión de la petición (sid del access token). Sirve para cerrar las demás y no la actual. */
  sessionId?: string;
  /** Cómo se autenticó la petición: sesión (JWT) o token de acceso personal (issue #65). */
  authMethod?: 'jwt' | 'pat';
  /** Token de acceso personal usado, si authMethod es 'pat'. */
  tokenId?: string;
  /** Permisos que concede el token; se combinan con los del rol actual del usuario. */
  tokenPermissions?: readonly Permission[];
}

export interface RequestAuditContext {
  ipAddress?: string;
  userAgent?: string;
}

export type AuthenticatedRequest = Request & { user: AuthenticatedUser };
