-- Issue #32 (S2-08): evento de auditoría para la exploración paginada de datos (RNF-06).

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'BROWSE_DATA';
