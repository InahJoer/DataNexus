-- Issue #39 (S3-05): historial de ejecuciones de reportes.
-- ScheduledReportRun (issue #38) pasa a ser ReportExecution y registra también los reportes bajo demanda.
-- Se renombra en lugar de recrear la tabla para conservar el historial existente.

-- Tipos
ALTER TYPE "ScheduledReportRunStatus" RENAME TO "ReportExecutionStatus";
ALTER TYPE "ScheduledReportTrigger" RENAME TO "ReportExecutionTrigger";
ALTER TYPE "ReportExecutionTrigger" ADD VALUE 'ON_DEMAND';

-- Tabla, clave primaria, índices y llaves foráneas con los nombres que genera Prisma
ALTER TABLE "ScheduledReportRun" RENAME TO "ReportExecution";
ALTER TABLE "ReportExecution" RENAME CONSTRAINT "ScheduledReportRun_pkey" TO "ReportExecution_pkey";
ALTER TABLE "ReportExecution" RENAME CONSTRAINT "ScheduledReportRun_workspaceId_fkey" TO "ReportExecution_workspaceId_fkey";
ALTER TABLE "ReportExecution" RENAME CONSTRAINT "ScheduledReportRun_scheduledReportId_fkey" TO "ReportExecution_scheduledReportId_fkey";
ALTER INDEX "ScheduledReportRun_idempotencyKey_key" RENAME TO "ReportExecution_idempotencyKey_key";
ALTER INDEX "ScheduledReportRun_workspaceId_startedAt_idx" RENAME TO "ReportExecution_workspaceId_startedAt_idx";
ALTER INDEX "ScheduledReportRun_scheduledReportId_startedAt_idx" RENAME TO "ReportExecution_scheduledReportId_startedAt_idx";
ALTER INDEX "ScheduledReportRun_status_leaseExpiresAt_idx" RENAME TO "ReportExecution_status_leaseExpiresAt_idx";

-- Los reportes bajo demanda no tienen programación
ALTER TABLE "ReportExecution" ALTER COLUMN "scheduledReportId" DROP NOT NULL;

-- Columnas nuevas
ALTER TABLE "ReportExecution"
  ADD COLUMN "titulo" TEXT,
  ADD COLUMN "formato" TEXT,
  ADD COLUMN "actorUserId" TEXT,
  ADD COLUMN "durationMs" INTEGER,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "fileSizeBytes" INTEGER,
  ADD COLUMN "authorNotifiedAt" TIMESTAMP(3);

-- Completa los datos de las ejecuciones que ya existían
UPDATE "ReportExecution" AS e
SET
  "durationMs" = CASE
    WHEN e."finishedAt" IS NOT NULL
      THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (e."finishedAt" - e."startedAt")) * 1000))::INTEGER
    END,
  "titulo" = s."nombre",
  "formato" = LOWER(s."formato"::TEXT)
FROM "ScheduledReport" AS s
WHERE s."id" = e."scheduledReportId";
