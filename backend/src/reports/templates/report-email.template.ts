import { renderEmail } from '../../mailer/templates/email-layout.js';

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
  subject: string;
  text: string;
  html: string;
}

/** Correo con el enlace temporal de descarga de un reporte (RF-22/RF-23). */
export function renderReportEmail(data: ReportEmailTemplateData): RenderedReportEmail {
  return renderEmail(`[DataNexus] ${data.reportTitle}`, {
    title: data.reportTitle,
    eyebrow: 'Reporte ejecutivo',
    preheader: `${data.filename} · ${data.fileSizeLabel}`,
    paragraphs: [data.customMessage],
    details: [
      { label: 'Archivo', value: data.filename },
      { label: 'Tamaño', value: `${data.fileSizeLabel} (${data.fileSizeBytes} bytes)` },
      { label: 'Generado', value: data.generatedAt },
    ],
    action: { label: 'Descargar reporte', url: data.downloadUrl },
    footnote: `Este enlace seguro vence el ${data.expiresAt}.`,
  });
}
