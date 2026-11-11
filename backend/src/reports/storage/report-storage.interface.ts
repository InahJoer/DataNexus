import type { Readable } from 'node:stream';
import type { ReportWriteTarget } from './report-write-target.js';

export const REPORT_STORAGE_ADAPTER = Symbol('REPORT_STORAGE_ADAPTER');
export const REPORT_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface LocalReportDownload {
  stream: Readable;
  filename: string;
  contentType: string;
}

export interface ReportStorageAdapter {
  createWriteTarget(id: string, contentType: string): Promise<ReportWriteTarget>;
  createDownloadUrl(id: string, filename: string): Promise<{ url: string; expiresAt: string }>;
  openLocalDownload(
    id: string,
    filename: string,
    expires: string,
    signature: string,
  ): Promise<LocalReportDownload>;
}

/** Tipos de archivo que admite un reporte, por extensión. */
export const REPORT_CONTENT_TYPES_BY_EXTENSION = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
} as const;

export const REPORT_FILENAME_PATTERN = /^datanexus_export_[0-9TZ-]+\.(xlsx|csv|pdf|docx|json)$/;

export function isReportContentType(contentType: string): boolean {
  return (Object.values(REPORT_CONTENT_TYPES_BY_EXTENSION) as string[]).includes(contentType);
}

/** Tipo de contenido según la extensión; el nombre ya fue validado con REPORT_FILENAME_PATTERN. */
export function reportContentTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1) as keyof typeof REPORT_CONTENT_TYPES_BY_EXTENSION;
  return REPORT_CONTENT_TYPES_BY_EXTENSION[extension] ?? 'application/octet-stream';
}
