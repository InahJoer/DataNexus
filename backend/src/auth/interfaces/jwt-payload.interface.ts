import type { UserRole } from './user-role.js';

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  workspaceId: string;
}
