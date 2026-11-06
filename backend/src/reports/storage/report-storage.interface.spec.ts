import { describe, expect, it } from 'vitest';
import {
  REPORT_FILENAME_PATTERN,
  isReportContentType,
  reportContentTypeFor,
} from './report-storage.interface.js';

describe('Tipos de archivo de reportes', () => {
  it.each([
    ['datanexus_export_2026-11-06T18-30-00-000Z.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['datanexus_export_2026-11-06T18-30-00-000Z.pdf', 'application/pdf'],
    ['datanexus_export_2026-11-06T18-30-00-000Z.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ])('acepta %s', (filename, contentType) => {
    expect(REPORT_FILENAME_PATTERN.test(filename)).toBe(true);
    expect(reportContentTypeFor(filename)).toBe(contentType);
    expect(isReportContentType(contentType)).toBe(true);
  });

  it.each([
    'datanexus_export_2026.doc',
    'datanexus_export_2026.docx.exe',
    '../datanexus_export_2026.docx',
    'otro_2026.docx',
  ])('rechaza el nombre %s', (filename) => {
    expect(REPORT_FILENAME_PATTERN.test(filename)).toBe(false);
  });

  it('rechaza tipos de contenido no admitidos', () => {
    expect(isReportContentType('application/msword')).toBe(false);
    expect(isReportContentType('text/html')).toBe(false);
  });
});
