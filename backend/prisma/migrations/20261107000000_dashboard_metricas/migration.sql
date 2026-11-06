-- Issue #40 (S3-06): datos para el dashboard de métricas del workspace.

-- Último health check de cada conexión
ALTER TABLE "ConexionDB"
  ADD COLUMN "ultimoHealthStatus" TEXT,
  ADD COLUMN "ultimaLatenciaMs" INTEGER,
  ADD COLUMN "ultimoHealthAt" TIMESTAMP(3);

-- Uso diario por workspace: solicitudes a la API y bytes procesados
CREATE TABLE "WorkspaceUsageDaily" (
    "workspaceId" TEXT NOT NULL,
    "dia" DATE NOT NULL,
    "solicitudesApi" INTEGER NOT NULL DEFAULT 0,
    "bytesProcesados" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "WorkspaceUsageDaily_pkey" PRIMARY KEY ("workspaceId","dia")
);

ALTER TABLE "WorkspaceUsageDaily" ADD CONSTRAINT "WorkspaceUsageDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
