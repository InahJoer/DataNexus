-- Issue #35 (S3-01): consultas guardadas (vistas unificadas) del Query Builder.

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'SAVED_QUERY_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'SAVED_QUERY_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE 'SAVED_QUERY_DELETED';

-- CreateEnum
CREATE TYPE "SavedQueryVisibility" AS ENUM ('PRIVADA', 'PUBLICADA');

-- CreateTable
CREATE TABLE "SavedQuery" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "definicion" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "visibilidad" "SavedQueryVisibility" NOT NULL DEFAULT 'PRIVADA',
    "autorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedQueryVersion" (
    "id" TEXT NOT NULL,
    "savedQueryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definicion" JSONB NOT NULL,
    "autorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedQueryVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SavedQuery_workspaceId_nombre_key" ON "SavedQuery"("workspaceId", "nombre");
CREATE INDEX "SavedQuery_workspaceId_visibilidad_idx" ON "SavedQuery"("workspaceId", "visibilidad");
CREATE UNIQUE INDEX "SavedQueryVersion_savedQueryId_version_key" ON "SavedQueryVersion"("savedQueryId", "version");

-- AddForeignKey
ALTER TABLE "SavedQuery" ADD CONSTRAINT "SavedQuery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedQuery" ADD CONSTRAINT "SavedQuery_autorId_fkey" FOREIGN KEY ("autorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SavedQueryVersion" ADD CONSTRAINT "SavedQueryVersion_savedQueryId_fkey" FOREIGN KEY ("savedQueryId") REFERENCES "SavedQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedQueryVersion" ADD CONSTRAINT "SavedQueryVersion_autorId_fkey" FOREIGN KEY ("autorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
