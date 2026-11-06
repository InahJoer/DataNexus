-- Issue #23 (S1-07): configuración del workspace (RF-05) y evento de auditoría WORKSPACE_UPDATED.

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'WORKSPACE_UPDATED';

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "camposSensibles" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "dominiosPermitidos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fechaActualizacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "zonaHoraria" TEXT NOT NULL DEFAULT 'UTC';

