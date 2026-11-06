-- Issue #24 (S1-08): invitaciones por enlace con token, aceptación y baja de miembros (RF-06).

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDIENTE', 'ACEPTADA', 'REVOCADA');

-- AlterEnum
-- Requiere PostgreSQL 12+ (varios valores de enum en una misma migración).
ALTER TYPE "AuditEventType" ADD VALUE 'INVITATION_RESENT';
ALTER TYPE "AuditEventType" ADD VALUE 'INVITATION_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE 'INVITATION_ACCEPTED';
ALTER TYPE "AuditEventType" ADD VALUE 'USER_REMOVED';

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDIENTE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_workspaceId_status_idx" ON "Invitation"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

