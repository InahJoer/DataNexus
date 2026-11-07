-- Perfil, cambio de contraseña y revocación de sesiones (#64).
ALTER TYPE "AuditEventType" ADD VALUE 'PROFILE_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "AuditEventType" ADD VALUE 'SESSIONS_REVOKED';
