-- Issue #22: bloqueo temporal de la cuenta tras intentos de login fallidos.

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'ACCOUNT_LOCKED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

