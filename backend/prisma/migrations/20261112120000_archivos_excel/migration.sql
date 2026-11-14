-- Archivos de Excel como fuente de datos (explorador y editor de consultas).
ALTER TYPE "AuditEventType" ADD VALUE 'EXCEL_UPLOADED';
ALTER TYPE "AuditEventType" ADD VALUE 'EXCEL_REPLACED';
ALTER TYPE "AuditEventType" ADD VALUE 'EXCEL_DELETED';

CREATE TABLE "ArchivoExcel" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "nombreArchivo" TEXT NOT NULL,
    "tamanoBytes" INTEGER NOT NULL,
    "creadoPor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "ArchivoExcel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HojaExcel" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "posicion" INTEGER NOT NULL,
    "columnas" JSONB NOT NULL,
    "columnaId" TEXT NOT NULL,
    "totalFilas" INTEGER NOT NULL,
    "filas" JSONB NOT NULL,
    "archivoId" TEXT NOT NULL,

    CONSTRAINT "HojaExcel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ArchivoExcel_workspaceId_idx" ON "ArchivoExcel"("workspaceId");
CREATE UNIQUE INDEX "HojaExcel_archivoId_nombre_key" ON "HojaExcel"("archivoId", "nombre");

ALTER TABLE "ArchivoExcel" ADD CONSTRAINT "ArchivoExcel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HojaExcel" ADD CONSTRAINT "HojaExcel_archivoId_fkey" FOREIGN KEY ("archivoId") REFERENCES "ArchivoExcel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
