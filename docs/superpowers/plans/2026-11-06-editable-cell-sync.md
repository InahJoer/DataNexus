# Cell Edit Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backend endpoint that conditionally updates a SQL or Firestore field, reports stale edits as HTTP 409, and records a role-safe `MODIFY_RECORD` audit event.

**Architecture:** Add a validated cell-update DTO and an optional write method to the data-source adapter contract. PostgreSQL, MySQL, and SQL Server lock the primary-key row in a transaction, compare the cell after applying the same normalization as browsing, and update with parameterized values; Firestore uses a transaction. The controller checks authorization, calls the data engine, and records the audit event after the source write; audit read/export redacts record identity and cell values for AUDITOR.

**Tech Stack:** NestJS 12, TypeScript, PostgreSQL/MySQL/SQL Server drivers, Google Cloud Firestore SDK, Prisma audit log.

**Spec:** `docs/superpowers/specs/2026-11-06-editable-cell-sync-design.md`

## Global Constraints

- Scope is backend only; do not build an editable frontend grid.
- Support PostgreSQL, MySQL, SQL Server, and Firestore; leave MongoDB without write support.
- Use `PATCH /engine/records` with connection, entity, optional schema, primary key, field, expected old value, and new value.
- A stale expected value returns HTTP 409 and must not overwrite the newer source value.
- Only ADMIN and OPERADOR may edit; LECTOR and AUDITOR are denied.
- Persist a `MODIFY_RECORD` event with before/after values. Do not log credentials or whole rows.
- AUDITOR can see the event metadata but must not receive the row key or before/after values through audit JSON or exports.
- When schema is omitted, resolve the target with the same per-adapter rule as `readPage`.
- If the source write succeeds but audit persistence fails, return HTTP 503 with `mutationApplied: true`; do not attempt a compensating write.
- Do not add or run tests/builds unless separately requested; perform manual diff review only.

## Review Focus

- Stale value races must return 409 without changing the cell; inspect SQL row locks, normalized equality and the Firestore transaction flow.
- String-only changes on case-insensitive SQL collations must still be recognized as stale values.
- Table, schema, and field names must be metadata-validated/escaped; values must remain driver parameters.
- Composite SQL keys must be complete and exact; Firestore must address documents by ID.
- A missing SQL row or Firestore document must not be reported as a successful edit.
- AUDITOR must not receive keys or before/after values from either audit listing or CSV/JSON export.

---

### Task 1: Define the edit contract and permission

**Files:**
- Create: `backend/src/data-engine/dto/update-record.dto.ts`
- Modify: `backend/src/data-engine/adapters/data-source-adapter.interface.ts`
- Modify: `backend/src/auth/interfaces/user-role.ts`

**Interfaces:**
- DTO: `conexionId`, `entidad`, optional `esquema`, `llavePrimaria`, `campo`, `valorAnterior`, and `valorNuevo`.
- SQL `llavePrimaria` is a non-empty map of column names to JSON scalar values; Firestore `llavePrimaria` is the document ID string.
- Cell values are JSON scalars: `string | number | boolean | null`.
- Add optional adapter method `updateRecord(connection, input): Promise<UpdateRecordResult>` so MongoDB remains read-only. It returns the normalized values actually stored before and after the operation. `input` carries entity, optional schema, key, field, expected value, and next value.
- Add `MODIFY_RECORDS: ['ADMIN', 'OPERADOR']` to the permission matrix without changing permissions added by issue #35.

- [x] Add DTO validation for required identifiers, key shape, scalar values, and bounded field/entity names.
- [x] Add the optional typed `IDataSourceAdapter.updateRecord` contract and add `MODIFY_RECORDS` to the role matrix.
- [x] Manually inspect that LECTOR and AUDITOR are not included and the latest `MANAGE_QUERIES`/`RUN_SAVED_QUERIES` entries remain intact.

### Task 2: Implement safe SQL and Firestore writes

**Files:**
- Modify: `backend/src/data-engine/adapters/postgres.adapter.ts`
- Modify: `backend/src/data-engine/adapters/mysql.adapter.ts`
- Modify: `backend/src/data-engine/adapters/sqlserver.adapter.ts`
- Modify: `backend/src/data-engine/adapters/firestore.adapter.ts`

**Interfaces:**
- Consumes: `IDataSourceAdapter.updateRecord` and the DTO scalar/key types from Task 1.
- Produces: adapter-level writes that resolve schemas like `readPage`, reject views and primary-key edits, and throw domain HTTP exceptions for missing rows or stale values.

- [x] Implement PostgreSQL update using a transaction and row lock by the exact catalog-validated key. Normalize the locked cell value as `readPage` does, compare strictly with the expected scalar (including `null`), then update with parameterized values.
- [x] Implement equivalent locked compare-and-set transactions in MySQL (InnoDB only) and SQL Server (`FOR UPDATE` / update-lock hints), validating exact key columns and rejecting generated/read-only fields. Compare normalized values in application code so a case-insensitive collation cannot accept a stale string.
- [x] Implement Firestore update inside a transaction, using the document ID; require the field to exist, compare its normalized scalar value, then write with a field path.
- [x] Map a missing record/document to 404 and a stale or absent expected field to 409; reject unsupported objects/fields without exposing SQL or credentials.
- [x] Manually compare each implementation with its existing `readPage` schema and key resolution.

### Task 3: Add the endpoint and audit behavior

**Files:**
- Modify: `backend/src/data-engine/data-engine.service.ts`
- Modify: `backend/src/data-engine/data-engine.controller.ts`
- Modify: `backend/src/audit/audit.service.ts`
- `backend/src/audit/audit.types.ts` already includes `MODIFY_RECORD` and target `RECORD` on the updated `main`; preserve those definitions.

**Interfaces:**
- Consumes: the update DTO and adapter method from Tasks 1–2.
- Produces: authenticated `PATCH /engine/records`; success response is `{ actualizada: true, entidad, campo, valorAnterior, valorNuevo }` using normalized values read from the source; stale/missing/source errors map to their HTTP status.
- Audit uses `eventType: 'MODIFY_RECORD'`, `targetType: 'RECORD'`, actor/workspace/request metadata, and a one-cell before/after detail.

- [x] Add `DataEngineService.updateRecord(actor, dto)`; check `MODIFY_RECORDS`, fetch the connection inside the actor workspace, and call only an adapter with write support.
- [x] Add guarded `PATCH /records` to `DataEngineController`, Swagger documentation, 403 and 409 responses, and audit event creation after a confirmed source update.
- [x] If the update succeeds but `AuditService.record` fails, return 503 with code `AUDIT_WRITE_FAILED_AFTER_MUTATION` and `mutationApplied: true`.
- [x] Add a `MODIFY_RECORD` allowlist to `serializeSafeDetails` for connection/entity/schema/key/field/before/after; exclude credentials and unrelated row data.
- [x] Redact record key and before/after values in `AuditService.findAll` and `AuditService.exportLogs` for AUDITOR while leaving ADMIN audit views unchanged.
- [x] Manually inspect both audit response paths to confirm redaction is applied before returning JSON, CSV, or JSON export data.

### Task 4: Document and review the branch

**Files:**
- Modify: `backend/docs/ARQUITECTURA.md`
- Review: `backend/src/data-engine`, `backend/src/audit`, and `backend/src/auth/interfaces/user-role.ts`

- [x] Document the endpoint payload, SQL/Firestore support, role rules, 409 stale-value behavior, audit visibility, and the 503 audit-failure case.
- [x] Review the whole branch against issue #36 and the approved design; the fresh reviewer findings were fixed and `git diff --check` is clean. No tests/builds were run under current instructions.
- [ ] Report the branch, changed files, commit message, PR description, and that tests/builds remain unverified.
