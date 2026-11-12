-- Tokens de acceso personal para integraciones (#65).
ALTER TYPE "AuditEventType" ADD VALUE 'PAT_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'PAT_ROTATED';
ALTER TYPE "AuditEventType" ADD VALUE 'PAT_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE 'PAT_USED';

CREATE TABLE "PersonalAccessToken" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefijo" TEXT NOT NULL,
    "permisos" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "rotatedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "PersonalAccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PersonalAccessToken_tokenHash_key" ON "PersonalAccessToken"("tokenHash");
CREATE INDEX "PersonalAccessToken_userId_idx" ON "PersonalAccessToken"("userId");
CREATE INDEX "PersonalAccessToken_workspaceId_idx" ON "PersonalAccessToken"("workspaceId");

ALTER TABLE "PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
