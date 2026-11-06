# Report storage and email templates

**Issue:** [#13](https://github.com/InahJoer/DataNexus/issues/13)  
**Status:** Approved

## Intent

Move generated report files out of Node.js memory and make scheduled report emails link to secure downloads. Keep local development usable without cloud credentials and render report emails from an HTML template.

## Current behavior

`DataEngineService.executeCrossJoinForExport` returns a complete `Buffer`. `ReportsService` attaches that buffer and builds report HTML inline. The direct `/data-engine/export` route also relies on the buffer response.

## Goals

- Stream Excel and PDF report output to storage instead of collecting the finished file in a `Buffer`.
- Store reports in Google Cloud Storage when configured; allow local filesystem storage through an environment setting.
- Include a 24-hour secure download link in report emails and omit the raw attachment.
- Render report email HTML with Handlebars and escaped template values.
- Preserve the existing direct `/data-engine/export` response behavior.

## Non-goals

- Add AWS S3 support in this change.
- Add a UI for editing templates or changing report branding per user.
- Stream the underlying cross-join rows; this change streams the generated file, while the current join still materializes its rows.
- Change the general-purpose `/data-engine/export` endpoint to object storage.

## Approaches

1. **Google Cloud Storage plus local filesystem adapter (selected).** This fits the existing Firebase/Firestore integrations and the repository already resolves the Google Cloud Storage SDK. Both targets accept a writable stream. GCS can return a V4 signed URL; local mode can return a short-lived HMAC-signed API download URL.
2. **Amazon S3 plus local filesystem adapter.** This follows the same storage interface but adds AWS-specific dependencies and credential configuration that the current project does not use.
3. **Keep generating buffers and upload after generation.** This requires the least refactoring but leaves the report file in memory and does not meet the issue's acceptance criterion.

## Proposed design

- Add a reports storage module with a common interface for creating a writable destination, and implementations for GCS and local disk. Select the implementation with `REPORT_STORAGE_PROVIDER`; local mode is the development fallback when GCS is not selected. If an explicitly selected GCS upload fails, fail the report instead of silently sending a local-only link.
- Add a streaming report export path for `ReportsService`. ExcelJS's streaming workbook writer and PDFKit will write directly to the selected destination. Keep the current buffer-based path for the direct export endpoint to limit unrelated API changes.
- Generate a random report ID and stable filename before writing. Use it as the object key or local filename. Do not add a database record in this issue.
- In GCS mode, generate a V4 signed URL that expires after 24 hours. In local mode, expose `GET /reports/download/:id` with an expiry and HMAC signature derived from the existing server secret; validate the ID and signature before streaming the file from the configured local directory. Use a configurable public API base URL when constructing local links, with `http://localhost:3001` for local development.
- Add a Handlebars report email template with the title, custom message, filename, size, generation time, and secure link. Escape dynamic HTML fields and send the report as a link instead of an attachment.
- Add `REPORT_STORAGE_PROVIDER=local|gcs`, `REPORTS_GCS_BUCKET`, `REPORTS_LOCAL_DIRECTORY`, and `REPORTS_PUBLIC_BASE_URL` to environment validation and `.env.example`. The provider defaults to local; a GCS selection requires a bucket.

## Constraints and security

- GCS uses Application Default Credentials; the bucket name is configured through the environment.
- Download links are bearer links valid for 24 hours. The local endpoint must reject expired links and malformed report IDs and must only access files under the configured report directory; the GCS bucket must remain private.
- Local storage in production requires an HTTPS `REPORTS_PUBLIC_BASE_URL`; development defaults to `http://localhost:3001`.
- No private credentials are added to source control.

## Implementation decisions

- Local files use the random report UUID as their disk key; the signed URL carries the human-readable filename.
- Count bytes in a transform stream so the API response and audit event retain file size without retaining file bytes.
