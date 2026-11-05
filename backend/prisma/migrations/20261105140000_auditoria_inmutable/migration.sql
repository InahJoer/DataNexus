-- Issue #19: bitácora de auditoría inmutable (RF-26) y nuevos eventos (RF-24/RF-25).

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'EXECUTE_JOIN';
ALTER TYPE "AuditEventType" ADD VALUE 'EXPORT';
ALTER TYPE "AuditEventType" ADD VALUE 'MODIFY_RECORD';
ALTER TYPE "AuditEventType" ADD VALUE 'AUDIT_LOG_EXPORTED';

-- La bitácora solo admite INSERT. Cualquier UPDATE, DELETE o TRUNCATE falla,
-- venga de Prisma, de SQL crudo o de un cliente externo como psql.
CREATE OR REPLACE FUNCTION "registro_auditoria_inmutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'La bitácora de auditoría es inmutable: % no está permitido sobre "RegistroAuditoria"', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "registro_auditoria_sin_update_delete"
BEFORE UPDATE OR DELETE ON "RegistroAuditoria"
FOR EACH ROW EXECUTE FUNCTION "registro_auditoria_inmutable"();

CREATE TRIGGER "registro_auditoria_sin_truncate"
BEFORE TRUNCATE ON "RegistroAuditoria"
FOR EACH STATEMENT EXECUTE FUNCTION "registro_auditoria_inmutable"();
