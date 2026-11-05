-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERADOR', 'LECTOR', 'AUDITOR');

-- CreateEnum
CREATE TYPE "TipoMotor" AS ENUM ('POSTGRESQL', 'MYSQL', 'SQLSERVER', 'FIRESTORE', 'MONGODB');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILURE', 'USER_ROLE_CHANGED', 'USER_INVITED', 'CONNECTION_CREATED', 'CONNECTION_UPDATED', 'CONNECTION_DELETED', 'REPORT_GENERATED_AND_SENT');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "nombreEmpresa" TEXT NOT NULL,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'LECTOR',
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConexionDB" (
    "id" TEXT NOT NULL,
    "nombre" TEXT,
    "tipoMotor" "TipoMotor" NOT NULL,
    "host" TEXT NOT NULL,
    "dbName" TEXT NOT NULL,
    "connectionStringEncriptada" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "ConexionDB_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistroAuditoria" (
    "id" TEXT NOT NULL,
    "eventType" "AuditEventType" NOT NULL,
    "outcome" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "workspaceId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "detailsJson" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistroAuditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_workspaceId_idx" ON "User"("workspaceId");

-- CreateIndex
CREATE INDEX "ConexionDB_workspaceId_idx" ON "ConexionDB"("workspaceId");

-- CreateIndex
CREATE INDEX "RegistroAuditoria_workspaceId_createdAt_idx" ON "RegistroAuditoria"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "RegistroAuditoria_actorUserId_createdAt_idx" ON "RegistroAuditoria"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "RegistroAuditoria_eventType_createdAt_idx" ON "RegistroAuditoria"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConexionDB" ADD CONSTRAINT "ConexionDB_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

