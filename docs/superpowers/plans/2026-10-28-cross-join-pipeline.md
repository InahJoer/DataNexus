# Cross-Join Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Push cross-join filters into SQL Server and Firestore, then support memory-conscious post-join grouping and aggregates.

**Architecture:** Add a shared validated filter type to the cross-join DTO and extractor options. Each adapter translates it into its native parameterized/query API. The join service feeds matched merged rows into an incremental aggregator when `groupBy` or metrics are requested; otherwise current join behavior remains.

**Tech Stack:** NestJS DTO validation, class-transformer, mssql, Firebase Admin Firestore, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-cross-join-pipeline-design.md`

## Global Constraints

- Filters are ANDed criteria `{ campo, operador, valor }` using only `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, and `not-in`.
- `in` and `not-in` values contain 1–10 scalar values; SQL uses bound parameters and Firestore uses `.where()`.
- Aggregation metrics are `COUNT`, `SUM`, or `AVG`; `COUNT` can omit `field`, while `SUM` and `AVG` require a numeric field.
- Preserve workspace checks, masking, pagination, existing timeout and row/byte caps. LECTOR source values are masked before aggregation, and metrics derived from masked values stay masked under any alias.
- The stress test uses more than 10,000 source records and records elapsed time and heap change.

## Review Focus

- Unknown operators or crafted field names must not become executable SQL: cover DTO rejection and adapter identifier validation in Task 1/2.
- Empty or oversized list filters must be rejected before reaching either provider: cover in Task 1 and SQL/Firestore translations in Tasks 2/3.
- Null equality and inequality must preserve provider semantics: cover SQL `IS NULL` / `IS NOT NULL` and Firestore mapping in Tasks 2/3.
- Duplicate joined field names and special aliases must remain addressable: cover `sql.` / `nosql.` group keys and `__proto__` aliases in Task 4.
- Empty inputs and null metric values must produce stable grouped or aggregate output: cover in Task 4.
- LECTOR aggregates must not expose sensitive source values through arbitrary aliases: cover query and export paths in Task 4.

---

### Task 1: Filter and aggregate DTO contract

**Files:**
- Modify: `src/data-engine/dto/cross-join.dto.ts`
- Create: `src/data-engine/dto/cross-join.dto.spec.ts`

**Interfaces:**
- Produces `DataFilterDto` with `campo`, `operador`, `valor`; optional `filtrosSql` and `filtrosNoSql` arrays.
- Produces optional `groupBy: string[]` and `aggregations: { operation: 'COUNT' | 'SUM' | 'AVG'; field?: string; as: string }[]`.

- [x] Write tests for valid nested filters/aggregations, unknown operator rejection, empty/oversized `in` arrays, and required `field` for `SUM` / `AVG`.
- [x] Run `npm test -- src/data-engine/dto/cross-join.dto.spec.ts`; confirm the new DTO fields fail validation before implementation.
- [x] Add nested DTO classes, Swagger metadata, and validation decorators for the contract above.
- [x] Rerun the focused DTO test and confirm it passes.

### Task 2: SQL Server filter pushdown

**Files:**
- Modify: `src/data-engine/adapters/data-extractor.adapter.ts`
- Modify: `src/data-engine/adapters/sqlserver-data-extractor.ts`
- Modify: `src/data-engine/adapters/sqlserver-data-extractor.spec.ts`

**Interfaces:**
- `DataExtractorOptions` gains `filters?: DataFilter[]`; `extract(connection, table, options?)` remains the shared interface.
- SQL select construction returns SQL plus named parameters; field names use existing identifier quoting and values use `request.input`.

- [x] Add tests asserting filters appear in SQL `WHERE`, values are bound rather than interpolated, `in` expands to individual parameters, null maps to `IS NULL` / `IS NOT NULL`, and an unknown field/operator is rejected.
- [x] Run `npm test -- src/data-engine/adapters/sqlserver-data-extractor.spec.ts`; confirm missing pushdown fails.
- [x] Pass filters into the source select and bind all filter values before starting its row stream.
- [x] Rerun the focused SQL adapter test.

### Task 3: Firestore filter pushdown

**Files:**
- Modify: `src/data-engine/adapters/firestore-data-extractor.ts`
- Modify: `src/data-engine/adapters/firestore-data-extractor.spec.ts`

**Interfaces:**
- Firestore `extract` accepts the same `DataExtractorOptions` and chains one `.where(field, operator, value)` per criterion before `.limit()`.

- [x] Add tests for operator translation, multiple AND filters, and an unfiltered collection retaining existing behavior and caps.
- [x] Run `npm test -- src/data-engine/adapters/firestore-data-extractor.spec.ts`; confirm missing pushdown fails.
- [x] Apply validated filters to the native Firestore query before streaming documents.
- [x] Rerun the focused Firestore adapter test.

### Task 4: Cross-join aggregation pipeline and stress coverage

**Files:**
- Modify: `src/data-engine/data-engine.service.ts`
- Modify: `src/data-engine/data-engine.service.spec.ts`
- Modify: `src/data-engine/masking/masking.service.ts`
- Test: `src/data-engine/masking/masking.service.spec.ts`

**Interfaces:**
- `performJoin` passes `{ schema, filters }` to SQL extraction and `{ filters }` to NoSQL extraction.
- With no aggregation options it returns existing merged rows. With `groupBy` or `aggregations`, it incrementally returns aggregate rows, preserving raw join row limits and checking the retained aggregate result against the byte cap.

- [x] Add service tests for filter options sent to both adapters, grouped `COUNT`, `SUM`, `AVG`, both duplicate field prefixes, empty inputs, null/non-numeric values, LECTOR masking in query/export, special aliases, and own-property reads.
- [x] Add a stress test with 12,000 joined source rows and grouped output; measure `performance.now()` duration and `process.memoryUsage().heapUsed` change, asserting under 2 seconds and under 64 MiB heap growth.
- [x] Run `npm test -- src/data-engine/data-engine.service.spec.ts`; confirm the new API and aggregate behaviors fail before implementation.
- [x] Implement source option forwarding and incremental post-join aggregation without changing the non-aggregate path; mask LECTOR source fields before aggregation and keep masked metrics masked under arbitrary aliases.
- [x] Rerun the focused service test and targeted coverage for the DTO, adapters, and service; ensure new functionality coverage is at least 85%.
