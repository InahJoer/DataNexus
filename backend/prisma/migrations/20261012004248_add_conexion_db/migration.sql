-- CreateTable
CREATE TABLE "ConexionDB" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tipoMotor" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "dbName" TEXT NOT NULL,
    "connectionStringEncriptada" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    CONSTRAINT "ConexionDB_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
