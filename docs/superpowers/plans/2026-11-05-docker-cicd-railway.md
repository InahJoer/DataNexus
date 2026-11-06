# Docker, CI/CD y Railway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-ready Docker images, local development with the existing PostgreSQL Compose stack, production containers using external PostgreSQL, CI and GHCR publishing, with Railway CD gated off by default.

**Architecture:** Build frontend and backend as independent multi-stage Node.js images. Development Compose runs both services with the existing local PostgreSQL service; production Compose accepts an external PostgreSQL URL. GitHub Actions validates the monorepo, publishes commit-tagged images, and contains a Railway deployment job that only activates on `main` when explicitly enabled.

**Tech Stack:** Next.js 16, React 19, NestJS 12, Prisma 6, PostgreSQL, Docker Compose, GitHub Actions, GHCR, Railway CLI.

**Spec:** `docs/superpowers/specs/2026-11-05-docker-cicd-railway-design.md`

## Global Constraints

- Use PostgreSQL as DataNexus's internal database; omit SQLite.
- Preserve existing application features and Prisma migrations.
- Use `npm ci` for reproducible installs.
- Keep secrets out of Docker images and workflow files.
- Do not deploy, commit, or push during this task.
- Keep Railway CD disabled unless `ENABLE_RAILWAY_CD` is explicitly set to `true`.

## Review Focus

- Frontend API URL is embedded at build time; Compose and later Railway builds must provide the correct URL.
- Development backend waits for local PostgreSQL health; production backend applies Prisma migrations against the external `DATABASE_URL`.
- Production-only secrets must be supplied through environment configuration, never Docker build args.
- GHCR publishing must not run on Pull Requests and must not run before CI and both image builds pass.
- Serialize workflow runs by branch so an older push cannot replace a newer `latest` image.
- Railway deploy must require both the production branch and explicit enablement, preventing accidental deployment.

---

### Task 1: Frontend container

**Files:**
- Create `Dockerfile`
- Create `.dockerignore`
- Modify `next.config.ts` to enable standalone output

**Interfaces:**
- Consumes `NEXT_PUBLIC_API_URL` as a build argument, defaulting to `http://localhost:3001` for local Compose.
- Produces a minimal production image listening on `0.0.0.0:${PORT:-3000}`.

- [x] Add a multi-stage Dockerfile using the existing npm lockfile, `npm ci`, and `npm run build`.
- [x] Provide separate development and production targets; development runs Next dev on `0.0.0.0`.
- [x] Copy standalone server, static assets, and public assets into the runtime stage.
- [x] Exclude local dependencies, build outputs, Git metadata, and environment files through `.dockerignore`.
- [ ] Check the generated image build and confirm the container exposes the frontend response.

### Task 2: Backend container and local stack

**Files:**
- Create `backend/Dockerfile`
- Create `backend/.dockerignore`
- Create root `docker-compose.yml`
- Create root `docker-compose.prod.yml`
- Modify `backend/package.json` and `backend/package-lock.json` to keep the current Prisma CLI version available in production.
- Modify `backend/package.json` so `db:up` targets the root Compose definition.
- Create `docs/DOCKER-CICD-RAILWAY.md`

**Interfaces:**
- Backend reads `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `FRONTEND_URL`, and `PORT` from its runtime environment.
- Development Compose services: `frontend`, `backend`, and the existing `postgres`; keep the `backend` project name to reuse its current container and named volume.
- `docker-compose.yml` uses development targets and bind mounts; `docker-compose.prod.yml` uses runner targets, no source mounts, and external `DATABASE_URL`.

- [x] Build backend in stages with `npm ci`, Prisma Client generation, Nest build, and production startup.
- [x] Provide a development target using `npm run dev`; keep production dependencies and Prisma migrations available in the runtime target.
- [x] Install required OpenSSL/build runtime dependencies for Prisma and bcrypt without copying secrets.
- [x] Include the existing PostgreSQL Compose model rather than creating a second database definition; configure backend dependency, local ports, and development secrets.
- [x] Add a production Compose file using optimized targets, external PostgreSQL, and real runtime secrets.
- [x] Apply existing migrations with `prisma migrate deploy` before backend startup; do not reset data.
- [x] Document local setup, migration, Railway environment variables, and GHCR image names.
- [ ] Check Compose configuration and build the Docker images once.

### Task 3: CI and GHCR

**Files:**
- Create `.github/workflows/ci-cd.yml`

**Interfaces:**
- CI triggers on pushes to `DOCKERCICD` and `main`, Pull Requests to `main`, and manual dispatch.
- GHCR images are named separately for frontend and backend and tagged with the commit SHA.

- [x] Add a PostgreSQL service for backend migrations and tests.
- [x] Install backend dependencies reproducibly, generate Prisma Client, apply migrations, and run backend lint/tests against PostgreSQL.
- [x] Build both Docker images after checks; validate both images before publishing either one.
- [x] Publish images with the workflow's `GITHUB_TOKEN` only for non-PR events.
- [x] Confirm the workflow YAML is valid and branch/permission conditions match the spec.

### Task 4: Railway CD gate

**Files:**
- Modify `.github/workflows/ci-cd.yml`
- Modify `docs/DOCKER-CICD-RAILWAY.md`

**Interfaces:**
- CD uses `RAILWAY_TOKEN`, `RAILWAY_FRONTEND_SERVICE_ID`, and `RAILWAY_BACKEND_SERVICE_ID`.
- CD requires `github.ref == 'refs/heads/main'` and `vars.ENABLE_RAILWAY_CD == 'true'`.

- [x] Add a Railway deployment job that depends on successful image publishing and remains skipped by default.
- [x] Record Railway's PostgreSQL connection, per-service Dockerfile/image settings, and required secrets in the guide.
- [x] Verify no deploy job can run on `DOCKERCICD` or Pull Requests.

### Task 5: Final verification

- [x] Review `git diff --check` and `git status`.
- [ ] Run the minimal Docker Compose validation and build requested by the spec.
- [ ] Report any Docker daemon or registry limitation without committing or pushing.
