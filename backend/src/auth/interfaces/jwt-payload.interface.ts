import type { UserRole } from './user-role.js';

export interface JwtPayload {
  sub: string;
  /** Id de la UserSession. Sin sesión activa el token no es válido aunque no haya expirado. */
  sid: string;
  email: string;
  name: string;
  role: UserRole;
  workspaceId: string;
}
