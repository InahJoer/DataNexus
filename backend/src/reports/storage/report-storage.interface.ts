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
