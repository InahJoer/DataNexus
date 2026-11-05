# Dashboard Connection Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace dashboard sample connection states with live workspace connection health and refresh it every 60 seconds.

**Architecture:** Add an authenticated aggregate health endpoint to the existing data-engine controller. It uses the safe workspace connection list and existing bounded catalog explorers to report health, then the root Next.js dashboard consumes the typed response with the in-memory JWT.

**Tech Stack:** NestJS, Swagger, openapi-typescript, openapi-fetch, Next.js, React.

**Spec:** `docs/superpowers/specs/2026-10-30-dashboard-connection-health-design.md`

## Global Constraints

- Keep backend source in `backend/` and frontend source at repository root.
- Never return or log decrypted connection strings, credentials, or catalog contents.
- Health is a current probe only; do not store status history.
- Preserve role scoping: authenticated users see only their workspace.
- Keep non-connection dashboard metrics marked as sample data.
- Do not add or run tests unless requested; perform one backend build and browser review.

## Tasks

### Task 1: Expose typed connection-health API

**Files:** `backend/src/data-engine/data-engine.service.ts`, `backend/src/data-engine/data-engine.controller.ts`, new `backend/src/data-engine/dto/connection-health.dto.ts`.

- [x] Add `GET /engine/connections/health` with JWT guard and typed `ConnectionHealthResponseDto` Swagger response.
- [x] Query only safe workspace-scoped connection metadata, probe supported engines through the existing explorer, and return `HEALTHY`, `UNAVAILABLE`, or `UNSUPPORTED`, latency, and check time.
- [x] Keep each probe bounded by the current 10-second explorer timeout and convert driver errors into generic per-connection status.

### Task 2: Regenerate the client contract

**Files:** `lib/api/schema.d.ts`.

- [x] Regenerate from `http://localhost:3001/api/docs-json` and confirm the health response and status enum are typed.

### Task 3: Connect the dashboard UI

**Files:** `app/dashboard/page.tsx`, `components/connection-status.tsx`, `app/globals.css`.

- [x] Fetch health with the current in-memory bearer token on dashboard entry and every 60 seconds; avoid overlapping refreshes and preserve the last good response on refresh error.
- [x] Render loading, error/retry, empty, healthy, unavailable, and unsupported states without exposing driver details.
- [x] Drive the active-connection metric from the live response and show check latency/time in each connection row.

### Task 4: Review the first slice

- [x] Backend build passed; Swagger and the generated schema include the typed health route; Next compiled the dashboard and the browser confirmed its protected redirect.
- [x] Run `git diff --check`; do not add or run automated tests.
