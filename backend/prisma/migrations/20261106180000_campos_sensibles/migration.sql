-- Issue #34 (S2-10): campos sensibles configurables para el enmascaramiento (RF-20).

-- CreateEnum
CREATE TYPE "MaskingStrategy" AS ENUM ('EMAIL', 'PHONE', 'FULL', 'HASH');

-- conexionId y entidad vacíos = la regla aplica a todas. No se usa NULL para que el índice único funcione.

-- CreateTable
CREATE TABLE "SensitiveField" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conexionId" TEXT NOT NULL DEFAULT '',
    "entidad" TEXT NOT NULL DEFAULT '',
    "campo" TEXT NOT NULL,
    "estrategia" "MaskingStrategy" NOT NULL DEFAULT 'FULL',
    "creadoPor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SensitiveField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SensitiveField_workspaceId_conexionId_entidad_campo_key" ON "SensitiveField"("workspaceId", "conexionId", "entidad", "campo");
CREATE INDEX "SensitiveField_workspaceId_idx" ON "SensitiveField"("workspaceId");

-- AddForeignKey
ALTER TABLE "SensitiveField" ADD CONSTRAINT "SensitiveField_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
