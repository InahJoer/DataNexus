import { renderEmail, type RenderedEmail } from '../../mailer/templates/email-layout.js';

export interface ReportFailureEmailData {
  authorName: string;
  reportTitle: string;
  /** Mensaje seguro y breve, sin datos de conexión. */
  error: string;
  attempts: number;
  failedAt: string;
  /** Enlace al reporte en la aplicación, si se conoce la URL del frontend. */
  scheduleUrl?: string;
}

/** Aviso al autor de una programación cuando su reporte falla tras agotar los reintentos (issue #39). */
export function renderReportFailureEmail(data: ReportFailureEmailData): RenderedEmail {
  const attempts = data.attempts === 1 ? '1 intento' : `${data.attempts} intentos`;
  return renderEmail(`[DataNexus] Falló el reporte "${data.reportTitle}"`, {
    title: 'No se pudo completar tu reporte programado',
    eyebrow: 'Aviso de reporte programado',
    preheader: `${data.reportTitle}: ${data.error}`,
    tone: 'danger',
    paragraphs: [
      `Hola ${data.authorName},`,
      `El reporte "${data.reportTitle}" falló después de ${attempts}. Los destinatarios no recibieron el archivo de esta ejecución.`,
    ],
    details: [
      { label: 'Reporte', value: data.reportTitle },
      { label: 'Motivo', value: data.error },
      { label: 'Intentos', value: String(data.attempts) },
      { label: 'Fecha', value: data.failedAt },
    ],
    ...(data.scheduleUrl ? { action: { label: 'Revisar la programación', url: data.scheduleUrl } } : {}),
    footnote: 'Revisa la consulta guardada y el estado de las conexiones. Puedes ejecutar el reporte de nuevo con "Ejecutar ahora".',
  });
}
