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
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEventInput {
  eventType: AuditEventType;
  outcome: 'SUCCESS' | 'FAILURE';
  actorUserId?: string;
  actorEmail?: string;
  workspaceId?: string;
  targetType?: 'USER' | 'CONNECTION' | 'REPORT' | 'CROSS_JOIN' | 'AUDIT_LOG' | 'RECORD';
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export type AuditTransactionClient = Prisma.TransactionClient;
