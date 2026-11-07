-- Tipo de cuenta del workspace (personal u organización) y descripción.
CREATE TYPE "TipoCuenta" AS ENUM ('PERSONAL', 'ORGANIZACION');

ALTER TABLE "Workspace" ADD COLUMN "tipoCuenta" "TipoCuenta" NOT NULL DEFAULT 'ORGANIZACION';
ALTER TABLE "Workspace" ADD COLUMN "descripcion" TEXT;

-- Alta de cuentas desde /auth/signup.
ALTER TYPE "AuditEventType" ADD VALUE 'ACCOUNT_CREATED';
