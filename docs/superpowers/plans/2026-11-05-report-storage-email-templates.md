# Report Storage and Email Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Store generated email reports outside Node.js memory and send a secure, 24-hour download link in a rendered HTML email.

**Architecture:** Add a streaming export path for reports, keeping the current buffer-based direct export endpoint intact. A storage module selects Google Cloud Storage or the local filesystem; report emails use Handlebars, GCS signed URLs, or an HMAC-signed local download endpoint.

**Tech Stack:** NestJS 12, TypeScript, ExcelJS streaming writer, PDFKit, Google Cloud Storage, Node.js streams, Handlebars.

**Spec:** `docs/superpowers/specs/2026-11-05-report-storage-email-templates-design.md`

## Global Constraints

- GCS is the selected cloud provider; local filesystem is selected with `REPORT_STORAGE_PROVIDER=local` and is the default when no provider is configured.
- Secure download links expire after 24 hours.
- Excel and PDF report files must stream to storage; the report flow must not produce or attach a complete `Buffer`.
- Preserve the existing buffer-based `/data-engine/export` behavior.
- Do not add S3 support, a template editor, or report rows streaming in this change.
- Use GCS Application Default Credentials; do not add credentials to source control.
- When local storage is selected in production, require an HTTPS `REPORTS_PUBLIC_BASE_URL`; development uses `http://localhost:3001` by default.

## Review Focus

- Expired, malformed, or forged local links must not return a file.
- A local report ID must never permit path traversal outside the configured report directory.
- GCS links must expire after exactly 24 hours.
- Failed export or upload must not send an email or record a successful audit event.
- Template values from report titles and custom messages must remain HTML-escaped.

---

### Task 1: Add a streaming export path for reports

**Files:**
- Modify: `backend/src/data-engine/export/export.service.ts`
- Modify: `backend/src/data-engine/data-engine.service.ts`

**Interfaces:**
- Add `ExportService.writeExcel(data: Record<string, unknown>[], destination: Writable): Promise<void>` using ExcelJS's streaming workbook writer.
- Add `ExportService.writePdf(data: Record<string, unknown>[], title: string, destination: Writable): Promise<void>` using PDFKit's stream output.
- Add `DataEngineService.executeCrossJoinToStream(payload: ExportCrossJoinDto, user: AuthenticatedUser, destination: Writable): Promise<{ filename: string; contentType: string; totalRows: number }>`; it performs the same join and masking as the current export method, then calls the appropriate writer.
- Keep `executeCrossJoinForExport` and existing `Buffer` methods for `/data-engine/export`.

- [x] Add the two writable-stream export methods without collecting output chunks into a `Buffer`.
- [x] Add the report-specific data-engine method and preserve the current filename, content type, join, and masking behavior.
- [x] Review both paths to confirm only the new report path streams.

### Task 2: Add GCS and local report storage

**Files:**
- Create: `backend/src/reports/storage/report-storage.interface.ts`
- Create: `backend/src/reports/storage/report-write-target.ts`
- Create: `backend/src/reports/storage/report-storage.module.ts`
- Create: `backend/src/reports/storage/gcs-report-storage.service.ts`
- Create: `backend/src/reports/storage/local-report-storage.service.ts`
- Modify: `backend/src/config/env.validation.ts`
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Modify: `backend/.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Define `ReportStorageAdapter.createWriteTarget(id: string, contentType: string): Promise<{ writable: Writable; completed: Promise<number> }>`; `completed` resolves with bytes stored. The ID is the storage key, so the filename can be returned by the exporter after streaming.
- Define `ReportStorageAdapter.createDownloadUrl(id: string, filename: string): Promise<{ url: string; expiresAt: string }>`.
- Define `ReportStorageAdapter.openLocalDownload(id: string, filename: string, expires: string, signature: string): Promise<{ stream: Readable; filename: string; contentType: string }>`; it validates the signed link and is available only in local mode.
- Configure `REPORT_STORAGE_PROVIDER=local|gcs`, `REPORTS_GCS_BUCKET`, `REPORTS_LOCAL_DIRECTORY`, and `REPORTS_PUBLIC_BASE_URL`. Default the provider to `local`; require a bucket when `gcs` is selected.
- Use `@google-cloud/storage` directly with Application Default Credentials for GCS. GCS objects use random report IDs and V4 signed URLs with a 24-hour expiry.
- Pipe both implementations through a shared byte-counting stream. Local storage writes with `createWriteStream` under the configured directory and creates a URL to the local download endpoint with an HMAC signature and expiry.

- [x] Add the storage interface, provider token, and shared byte-counting write target so reports depend on the abstraction.
- [x] Implement the local filesystem writer and safe ID-to-path resolution.
- [x] Implement the GCS writer and signed URL generation.
- [x] Add environment validation and the corresponding `.env.example` entries.
- [x] Ignore files written under the configured local `storage/reports` fallback directory.

### Task 3: Send report emails with secure links

**Files:**
- Create: `backend/src/reports/templates/report-email.template.hbs`
- Create: `backend/src/reports/templates/report-email.template.ts`
- Modify: `backend/src/reports/reports.module.ts`
- Modify: `backend/src/reports/reports.service.ts`
- Modify: `backend/src/reports/reports.controller.ts`
- Modify: `backend/nest-cli.json`
- Modify: `backend/src/reports/reports.service.spec.ts` (update the existing fixture and assertion for the streaming/link contract; do not add new test cases)
- Modify: `backend/src/reports/dto/trigger-report.dto.ts` only if a download query DTO is needed
- Modify: `backend/src/mailer/mail.service.ts` only if required to remove report attachments
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`

**Interfaces:**
- `ReportsService.triggerReport` creates an ID, opens a storage write target, calls `executeCrossJoinToStream`, awaits storage completion, creates a download URL, and sends the email only after successful storage.
- Add `downloadUrl` and `expiresAt` to `ReportExecutionResult`; retain filename, format, row count, and stored file size for the response and audit record.
- Add `GET /reports/download/:id?filename=...&expires=...&signature=...` for local mode. It validates the generated ID, expiry, and HMAC in constant time before returning a file stream. The route is public because the signed URL is the authorization credential; the existing trigger route remains JWT-protected.
- Render report email with Handlebars variables `reportTitle`, `customMessage`, `filename`, `fileSizeBytes`, `generatedAt`, and `downloadUrl`. Send a link and no raw attachment.

- [x] Add the Handlebars report template and renderer.
- [x] Connect the report flow to the storage and streaming interfaces; keep audit and email success after storage completion only.
- [x] Add the local signed-download route and keep it scoped to local storage.
- [x] Update Swagger descriptions and `backend/docs/ARQUITECTURA.md` for the new link behavior.

### Task 4: Review the completed branch

**Files:**
- Review: all files listed above

- [x] Review the final diff for scope, escaping, expiry checks, path containment, and stream error handling.
- [x] Report the branch name, changed files, suggested commit message, PR description, and any unverified runtime behavior.
