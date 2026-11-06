import type { Prisma } from '@prisma/client';

/** Eventos de la bitácora. Debe coincidir con el enum AuditEventType de prisma/schema.prisma. */
export const AUDIT_EVENT_TYPES = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'USER_ROLE_CHANGED',
  'USER_INVITED',
  'CONNECTION_CREATED',
  'CONNECTION_UPDATED',
  'CONNECTION_DELETED',
  'REPORT_GENERATED_AND_SENT',
  'EXECUTE_JOIN',
  'EXPORT',
  /** Reservado para la edición de celdas (RF-18/RF-19). */
  'MODIFY_RECORD',
  'AUDIT_LOG_EXPORTED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET',
  'LOGOUT',
  'SESSION_EXPIRED',
  'REFRESH_TOKEN_REUSED',
  'ACCOUNT_LOCKED',
  'WORKSPACE_UPDATED',
  'INVITATION_RESENT',
  'INVITATION_REVOKED',
  'INVITATION_ACCEPTED',
  'USER_REMOVED',
  /** Exploración paginada de una tabla o colección (issue #32). Se registra la primera página de cada recorrido. */
  'BROWSE_DATA',
  /** Consultas guardadas del Query Builder (issue #35). Su ejecución se registra como EXECUTE_JOIN. */
  'SAVED_QUERY_CREATED',
  'SAVED_QUERY_UPDATED',
  'SAVED_QUERY_DELETED',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEventInput {
  eventType: AuditEventType;
  outcome: 'SUCCESS' | 'FAILURE';
  actorUserId?: string;
  actorEmail?: string;
  workspaceId?: string;
  targetType?: 'USER' | 'CONNECTION' | 'REPORT' | 'CROSS_JOIN' | 'AUDIT_LOG' | 'RECORD' | 'SESSION' | 'WORKSPACE' | 'INVITATION' | 'SAVED_QUERY';
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export type AuditTransactionClient = Prisma.TransactionClient;
