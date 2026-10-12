-- CreateTable
CREATE TABLE "RegistroAuditoria" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "workspaceId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "detailsJson" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "RegistroAuditoria_workspaceId_createdAt_idx" ON "RegistroAuditoria"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "RegistroAuditoria_actorUserId_createdAt_idx" ON "RegistroAuditoria"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "RegistroAuditoria_eventType_createdAt_idx" ON "RegistroAuditoria"("eventType", "createdAt");
