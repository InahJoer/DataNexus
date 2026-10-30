import type { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: string;
  workspaceId: string;
}

export interface RequestAuditContext {
  ipAddress?: string;
  userAgent?: string;
}

export type AuthenticatedRequest = Request & { user: AuthenticatedUser };
