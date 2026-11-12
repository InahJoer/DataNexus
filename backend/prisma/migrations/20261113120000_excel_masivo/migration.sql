-- Carga masiva de Excel: cada hoja se guarda en su propia tabla y el archivo se procesa en segundo plano.
CREATE TYPE "EstadoExcel" AS ENUM ('PROCESANDO', 'LISTO', 'ERROR');

ALTER TABLE "ArchivoExcel"
  ALTER COLUMN "tamanoBytes" SET DATA TYPE BIGINT,
  ADD COLUMN "estado" "EstadoExcel" NOT NULL DEFAULT 'LISTO',
  ADD COLUMN "progreso" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "filasProcesadas" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "error" TEXT,
  ADD COLUMN "avisos" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "HojaExcel"
  ADD COLUMN "tipos" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "tabla" TEXT,
  ALTER COLUMN "filas" DROP NOT NULL;

UPDATE "ArchivoExcel" a SET "filasProcesadas" = COALESCE((SELECT SUM(h."totalFilas") FROM "HojaExcel" h WHERE h."archivoId" = a."id"), 0);
