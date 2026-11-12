import { AUDIT_EVENT_TYPES, type AuditEventType } from './audit.types.js';

export const IMPACT_LEVELS = ['BAJO', 'MEDIO', 'ALTO'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

/**
 * Nivel de impacto de cada evento (#66), derivado de su tipo y sin tocar los registros (la bitácora es inmutable):
 * - ALTO: cambia la seguridad o la infraestructura (conexiones, roles, miembros, contraseñas, bloqueos, reutilización
 *   de tokens, edición de datos de origen o del workspace).
 * - MEDIO: mueve o expone datos (cruces, exportaciones, reportes, consultas, exploración) o gestiona invitaciones.
 * - BAJO: actividad normal de sesión.
 */
const HIGH: AuditEventType[] = [
  'CONNECTION_CREATED',
  'CONNECTION_UPDATED',
  'CONNECTION_DELETED',
  'USER_ROLE_CHANGED',
  'USER_REMOVED',
  'ACCOUNT_LOCKED',
  'REFRESH_TOKEN_REUSED',
  'PASSWORD_RESET',
  'PASSWORD_CHANGED',
  'SESSIONS_REVOKED',
  'MODIFY_RECORD',
  'WORKSPACE_UPDATED',
  'PAT_CREATED',
  'PAT_ROTATED',
  'PAT_REVOKED',
];
const MEDIUM: AuditEventType[] = [
  'EXECUTE_JOIN',
  'EXPORT',
  'AUDIT_LOG_EXPORTED',
  'REPORT_GENERATED_AND_SENT',
  'SCHEDULED_REPORT_CREATED',
  'SCHEDULED_REPORT_UPDATED',
  'SCHEDULED_REPORT_DELETED',
  'SCHEDULED_REPORT_RUN',
  'SAVED_QUERY_CREATED',
  'SAVED_QUERY_UPDATED',
  'SAVED_QUERY_DELETED',
  'BROWSE_DATA',
  'USER_INVITED',
  'INVITATION_RESENT',
  'INVITATION_REVOKED',
  'INVITATION_ACCEPTED',
  'LOGIN_FAILURE',
  'PASSWORD_RESET_REQUESTED',
  'ACCOUNT_CREATED',
  'PAT_USED',
];

export function impactOf(eventType: string): ImpactLevel {
  if ((HIGH as string[]).includes(eventType)) return 'ALTO';
  if ((MEDIUM as string[]).includes(eventType)) return 'MEDIO';
  return 'BAJO';
}

/** Tipos de evento de un nivel (para filtrar en la base). */
export function eventTypesWithImpact(level: ImpactLevel): AuditEventType[] {
  return AUDIT_EVENT_TYPES.filter((type) => impactOf(type) === level);
}
