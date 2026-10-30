# DataNexus Frontend Foundation — Design

## Intent

Restructure the repository into a small monorepo and begin a B2B SaaS interface for DataNexus. The first experience covers sign in, choosing the user's workspace, and a data operations dashboard.

## Goals

- Put the existing NestJS API and its runtime files in `/backend`.
- Add a separate `/frontend` Next.js app at the repository root level.
- Design the access and workspace-entry flow, followed by a dashboard view.
- Use realistic sample data so the UI can be reviewed before backend integration.
- Keep the existing API behavior and database model intact in this first frontend slice.

## Non-goals

- Add multi-workspace membership or workspace switching to the backend.
- Connect the first UI pass to live authentication, query, or reporting endpoints.
- Implement dashboard interactions beyond the navigation and controls needed to demonstrate the views.

## Constraints

- The current backend is NestJS 12, TypeScript, Prisma, and SQLite for local development.
- The existing architecture document already identifies Next.js as the web client.
- Current users have one `workspaceId`; login returns that ID, and there is no workspace-list endpoint.
- Keep Git metadata and developer-specific folders at the repository root. Generated `node_modules` and `dist` output are not source files to relocate.
- Preserve environment values without printing them; the backend `.env` belongs in `/backend` for local API execution.
- Keep commands simple and avoid unnecessary builds or broad validation runs.

## Approaches

1. **Sibling applications (recommended):** move the existing API project into `/backend` and create `/frontend` beside it. This gives each app a clear package boundary and follows the requested layout and the architecture's Next.js direction.
2. **Frontend at the repository root:** keep frontend source and its package manifest at the root while nesting only the API under `/backend`. This is a smaller directory count but mixes app ownership and root scripts as the project grows.
3. **Keep the current API at root:** add frontend files alongside it. This avoids moving files but does not satisfy the requested `backend/` boundary.

The recommended direction is the first approach. Unless corrected, this design assumes the workspace screen represents the single workspace associated with the signed-in user; it is an interface prototype backed by sample data until the API grows workspace-list support.

## View design

### Access and workspace entry

Treat access and workspace entry as one onboarding flow with two states: `/login` and `/workspaces`. The access view has a focused email/password form, a short product statement, and a restrained illustration or data-grid motif. On successful prototype sign-in, continue to a workspace card showing organization name, plan, and member count, with a clear “Open workspace” action. The first version uses sample data and does not claim to authenticate against the API.

### B2B SaaS dashboard

Use a clean, light workspace canvas with a dark ink navigation rail, teal/blue accents, and compact, readable data surfaces. Include a persistent workspace switcher, top-level search and date controls, KPI cards, a trend chart, connection health, recent activity, and a primary action for creating a report or data join. Populate these modules with clearly illustrative sample data.

## Calls left to the implementer

- Use the existing npm/TypeScript ecosystem; add the smallest frontend dependency set needed for a responsive Next.js app and dashboard chart.
- Keep the first dashboard layout responsive, with desktop as the primary design target.
- Keep the two onboarding states and the dashboard as distinct routes so the sequence can later be wired to real authentication and workspace APIs.
- Move backend-specific source, package/configuration files, Prisma files, tests, and backend documentation into `/backend`; update the root README and ignore rules to describe the new layout.

## Review questions

- Confirm whether workspace selection should initially show only the user's existing workspace, as the current API allows, or whether multi-workspace support belongs in this slice.
- Confirm the proposed sibling `/backend` and `/frontend` layout and Next.js frontend direction.
- Confirm that the first views may use sample data until a later API integration pass.
