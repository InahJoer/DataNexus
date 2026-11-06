-- Issue #38 (S3-04): reportes programados vinculados a consultas guardadas.

ALTER TYPE "AuditEventType" ADD VALUE 'SCHEDULED_REPORT_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'SCHEDULED_REPORT_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE 'SCHEDULED_REPORT_DELETED';
ALTER TYPE "AuditEventType" ADD VALUE 'SCHEDULED_REPORT_RUN';

CREATE TYPE "ScheduledReportFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');
CREATE TYPE "ScheduledReportStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR');
CREATE TYPE "ScheduledReportFormat" AS ENUM ('EXCEL', 'PDF', 'JSON');
CREATE TYPE "ScheduledReportRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "ScheduledReportTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

CREATE TABLE "ScheduledReport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "savedQueryId" TEXT NOT NULL,
    "createdById" TEXT,
    "nombre" TEXT NOT NULL,
    "frecuencia" "ScheduledReportFrequency" NOT NULL,
    "hora" TEXT NOT NULL,
    "diaSemana" INTEGER,
    "diaMes" INTEGER,
    "zonaHoraria" TEXT NOT NULL,
    "formato" "ScheduledReportFormat" NOT NULL,
    "destinatarios" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enviarCorreo" BOOLEAN NOT NULL DEFAULT TRUE,
    "estado" "ScheduledReportStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduledReportRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scheduledReportId" TEXT NOT NULL,
    "trigger" "ScheduledReportTrigger" NOT NULL,
    "status" "ScheduledReportRunStatus" NOT NULL DEFAULT 'RUNNING',
    "scheduledFor" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "totalRows" INTEGER,
    "error" TEXT,
    "downloadUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "messageId" TEXT,
    CONSTRAINT "ScheduledReportRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScheduledReportRun_idempotencyKey_key" ON "ScheduledReportRun"("idempotencyKey");
CREATE INDEX "ScheduledReport_workspaceId_estado_idx" ON "ScheduledReport"("workspaceId", "estado");
CREATE INDEX "ScheduledReport_savedQueryId_idx" ON "ScheduledReport"("savedQueryId");
CREATE INDEX "ScheduledReportRun_workspaceId_startedAt_idx" ON "ScheduledReportRun"("workspaceId", "startedAt");
CREATE INDEX "ScheduledReportRun_scheduledReportId_startedAt_idx" ON "ScheduledReportRun"("scheduledReportId", "startedAt");
CREATE INDEX "ScheduledReportRun_status_leaseExpiresAt_idx" ON "ScheduledReportRun"("status", "leaseExpiresAt");

ALTER TABLE "ScheduledReport"
  ADD CONSTRAINT "ScheduledReport_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ScheduledReport_savedQueryId_fkey"
    FOREIGN KEY ("savedQueryId") REFERENCES "SavedQuery"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ScheduledReport_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduledReportRun"
  ADD CONSTRAINT "ScheduledReportRun_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ScheduledReportRun_scheduledReportId_fkey"
    FOREIGN KEY ("scheduledReportId") REFERENCES "ScheduledReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
