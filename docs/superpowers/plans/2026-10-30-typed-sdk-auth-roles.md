# Typed API Client and Auth/Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the root Next.js app to the NestJS API with a generated OpenAPI client, in-memory JWT session, and role-aware navigation for `ADMIN`, `OPERADOR`, and `LECTOR`.

**Architecture:** NestJS Swagger at `/api/docs-json` is the type source; `openapi-typescript` generates endpoint/schema types and `openapi-fetch` performs typed requests. The backend validates the three-role union and admin-only actions. The frontend keeps the JWT only in React memory, validates the session with `/auth/profile`, and gates protected pages/navigation.

**Tech Stack:** Next.js, React, TypeScript, NestJS, Prisma, `openapi-typescript`, `openapi-fetch`.

**Spec:** GitHub issue #12 and the role/auth decisions approved in this conversation.

## Global Constraints

- Frontend source and package manifest stay at the repository root; backend code stays in `backend/`.
- Use in-memory bearer-token storage; do not persist JWTs in local or session storage.
- `LECTOR` receives masked cross-join results; `ADMIN` manages connections, users, and audit; `OPERADOR` may inspect connections and run/export joins but cannot administer users/connections or read audit.
- Keep dashboard metrics, cross-join builder, and audit UI data integration for later tasks.
- Do not add or run tests unless requested; use a single backend build and a browser review of the auth/navigation flow.


**Follow-up contract note:** Several live endpoints still have success responses without schemas in Swagger (connections, audit, joins, exports, reports). The generated client includes their request/path types; add response DTOs before wiring those views. The checked-in YAML also omits a few live routes, while this generator correctly uses `/api/docs-json`.

## Review Focus

- A missing/invalid token redirects protected views to `/login`; backend guards remain the authority for API access.
- The login response and `/auth/profile` types reflect the actual Swagger schema.
- Unsupported persisted roles cannot acquire a token or bypass result masking.
- Non-admin roles cannot use admin-only backend operations or see the audit navigation item.
- API failures display a safe, useful message without exposing tokens or passwords.

---

### Task 1: Make the backend role contract explicit

**Files:** `backend/src/auth/interfaces/user-role.ts`, authenticated-user/JWT interfaces, role decorator/guard, auth module/controller/service/strategy, connection/audit/user controllers, user role DTOs, `backend/docs/openapi/v1.yaml`, `backend/.env.example`.

**Produces:** Shared `UserRole` union, runtime validation for all three roles, declarative admin-only guards, typed Swagger responses for login/profile, and JWT signing/verification that requires `JWT_SECRET`.

- [x] Implement `ADMIN`, `OPERADOR`, and `LECTOR` across invitations, role changes, JWT validation, and controller authorization.
- [x] Document `AuthResponseDto` and profile response so `/api/docs-json` exposes usable request/response types.
- [x] Remove the code-level JWT secret fallback; retain environment-based configuration.
- [x] Align the checked-in OpenAPI version and role enums.

### Task 2: Generate and use the typed API client

**Files:** root `package.json`/`package-lock.json`, `lib/api/client.ts`, generated `lib/api/schema.d.ts`.

**Produces:** `npm run api:generate` reads `http://localhost:3001/api/docs-json`; `createApiClient(accessToken?)` returns a typed `openapi-fetch` client.

- [x] Add `openapi-fetch` and `openapi-typescript` in the correct dependency groups and add the generator script.
- [x] Run the generator against the local backend and produce the generated TypeScript contract.

### Task 3: Connect login and protected navigation

**Files:** `app/layout.tsx`, `app/login/login-form.tsx`, `app/workspaces/page.tsx`, `app/dashboard/page.tsx`, `components/auth-provider.tsx`, `components/require-auth.tsx`, `components/dashboard-sidebar.tsx`, `lib/auth-context.tsx`.

**Produces:** Successful login calls the API, checks `/auth/profile`, stores the token only in provider memory, navigates to the workspace, and gates protected pages and admin-only navigation.

- [x] Add the auth provider and in-memory session helpers.
- [x] Replace the mock login redirect with typed API login, loading/error states, and session setup.
- [x] Guard workspace/dashboard routes; show the signed-in user's name/role and hide audit navigation unless the user is `ADMIN`.
- [x] Add logout that clears in-memory state.

### Task 4: Verify the first integration slice

- [x] Backend build passed; Next.js dev compiled `/login`, `/workspaces`, and `/dashboard`; browser confirmed protected routes redirect to `/login` without a session.
- [x] Confirm the frontend uses the generated API client and no token persistence is introduced.
