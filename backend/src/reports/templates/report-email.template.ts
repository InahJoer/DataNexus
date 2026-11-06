import { readFileSync } from 'node:fs';
import Handlebars from 'handlebars';

export interface ReportEmailTemplateData {
  reportTitle: string;
  customMessage: string;
  filename: string;
  fileSizeBytes: number;
  fileSizeLabel: string;
  generatedAt: string;
  expiresAt: string;
  downloadUrl: string;
}

export interface RenderedReportEmail {
  text: string;
  html: string;
}

const renderHtml = Handlebars.compile(
  readFileSync(new URL('./report-email.template.hbs', import.meta.url), 'utf8'),
);

export function renderReportEmail(data: ReportEmailTemplateData): RenderedReportEmail {
  const downloadUrl = new URL(data.downloadUrl);
  if (
    !['https:', 'http:'].includes(downloadUrl.protocol) ||
    downloadUrl.username.length > 0 ||
    downloadUrl.password.length > 0
  ) {
    throw new Error('La URL de descarga del reporte no es válida');
  }

  const text = [
    data.customMessage,
    '',
    `Reporte: ${data.reportTitle}`,
    `Archivo: ${data.filename}`,
    `Tamaño: ${data.fileSizeLabel} (${data.fileSizeBytes} bytes)`,
    `Generado: ${data.generatedAt}`,
    `Descargar: ${downloadUrl.toString()}`,
    `El enlace vence: ${data.expiresAt}`,
  ].join('\n');

  return { text, html: renderHtml({ ...data, downloadUrl: downloadUrl.toString() }) };
}
