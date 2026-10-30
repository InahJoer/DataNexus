import type { Prisma } from '@prisma/client';

export type AuditEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'USER_ROLE_CHANGED'
  | 'CONNECTION_CREATED'
  | 'CONNECTION_UPDATED'
  | 'CONNECTION_DELETED';

export interface AuditEventInput {
  eventType: AuditEventType;
  outcome: 'SUCCESS' | 'FAILURE';
  actorUserId?: string;
  actorEmail?: string;
  workspaceId?: string;
  targetType?: 'USER' | 'CONNECTION';
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export type AuditTransactionClient = Prisma.TransactionClient;
