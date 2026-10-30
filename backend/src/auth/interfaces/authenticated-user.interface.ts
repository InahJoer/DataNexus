import type { Request } from 'express';
import type { UserRole } from './user-role.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  workspaceId: string;
}

export interface RequestAuditContext {
  ipAddress?: string;
  userAgent?: string;
}

export type AuthenticatedRequest = Request & { user: AuthenticatedUser };
