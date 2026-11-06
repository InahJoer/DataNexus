-- Issue #26 (S2-02): credenciales estructuradas por motor y metadatos no secretos (RF-08/RF-09).
-- Las conexiones existentes quedan en la versión 1 (cadena de conexión libre) y siguen funcionando.

-- AlterTable
ALTER TABLE "ConexionDB" ADD COLUMN     "credencialesVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "detalles" JSONB;

