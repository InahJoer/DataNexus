/**
 * Layout común de los correos de DataNexus (issue #39): reportes, fallos de reportes,
 * invitaciones y recuperación de contraseña comparten estructura, colores y escapado.
 * Todo el HTML es en línea y basado en tablas para que se vea igual en Outlook, Gmail y móviles.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EmailAction {
  label: string;
  url: string;
}

export interface EmailDetail {
  label: string;
  value: string;
}

export type EmailTone = 'default' | 'danger';

export interface EmailLayoutOptions {
  /** Título de la pestaña y encabezado principal. */
  title: string;
  /** Texto corto que los clientes de correo muestran junto al asunto. */
  preheader?: string;
  /** Etiqueta sobre el título, p. ej. "Reporte programado". */
  eyebrow?: string;
  /** Párrafos del cuerpo, en texto plano (se escapan). */
  paragraphs: string[];
  /** Tabla de datos clave, p. ej. archivo, tamaño, fecha. */
  details?: EmailDetail[];
  action?: EmailAction;
  /** Nota pequeña bajo el botón; si hay acción se añade el enlace copiable. */
  footnote?: string;
  tone?: EmailTone;
}

const BRAND = {
  header: '#173f68',
  headerText: '#d9e7f5',
  title: '#173f68',
  button: '#1f5f96',
  danger: '#b42318',
  dangerSoft: '#fef3f2',
  body: '#1f2937',
  muted: '#64748b',
  border: '#e6ebf2',
  panel: '#f7f9fc',
  page: '#f3f6fb',
};

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/** Solo admite enlaces http(s) sin credenciales: evita `javascript:` y URLs con usuario:clave. */
export function assertSafeEmailUrl(url: string): string {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('La URL del correo no es válida');
  }
  return parsed.toString();
}

function renderDetails(details: EmailDetail[], tone: EmailTone): string {
  const background = tone === 'danger' ? BRAND.dangerSoft : BRAND.panel;
  const rows = details
    .map(
      (detail) => `
            <tr>
              <td style="padding:8px 18px 0;font-size:11px;letter-spacing:.06em;color:${BRAND.muted};">${escapeHtml(detail.label.toUpperCase())}</td>
            </tr>
            <tr>
              <td style="padding:2px 18px 8px;font-size:14px;font-weight:600;color:${BRAND.body};word-break:break-word;">${escapeHtml(detail.value)}</td>
            </tr>`,
    )
    .join('');
  return `
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;background:${background};border:1px solid ${BRAND.border};border-radius:10px;">
            <tr><td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>${rows}
            <tr><td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>
          </table>`;
}

export function renderEmailLayout(options: EmailLayoutOptions): string {
  const tone = options.tone ?? 'default';
  const accent = tone === 'danger' ? BRAND.danger : BRAND.title;
  const actionUrl = options.action ? escapeHtml(assertSafeEmailUrl(options.action.url)) : undefined;

  const paragraphs = options.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;line-height:1.6;white-space:pre-line;">${escapeHtml(paragraph)}</p>`,
    )
    .join('\n          ');

  const action = options.action
    ? `<p style="margin:8px 0 22px;">
            <a href="${actionUrl}" style="display:inline-block;padding:13px 20px;background:${tone === 'danger' ? BRAND.danger : BRAND.button};color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">${escapeHtml(options.action.label)}</a>
          </p>`
    : '';

  const footnote =
    options.footnote || options.action
      ? `<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">${options.footnote ? escapeHtml(options.footnote) : ''}${
          options.action
            ? `${options.footnote ? '<br>' : ''}Si el botón no abre, copia este enlace en tu navegador:<br><a href="${actionUrl}" style="color:${BRAND.button};word-break:break-all;">${actionUrl}</a>`
            : ''
        }</p>`
      : '';

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)} | DataNexus</title>
  </head>
  <body style="margin:0;padding:28px 12px;background:${BRAND.page};font-family:Segoe UI,Arial,Helvetica,sans-serif;color:${BRAND.body};">
    ${options.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(options.preheader)}</div>` : ''}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid ${BRAND.border};border-radius:14px;overflow:hidden;">
      <tr>
        <td style="padding:22px 30px;background:${BRAND.header};color:#ffffff;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:.14em;">DATANEXUS</p>
          <p style="margin:0;font-size:13px;color:${BRAND.headerText};">${escapeHtml(options.eyebrow ?? 'Plataforma de datos unificados')}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:30px;">
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${accent};">${escapeHtml(options.title)}</h1>
          ${paragraphs}
          ${options.details?.length ? renderDetails(options.details, tone) : ''}
          ${action}
          ${footnote}
        </td>
      </tr>
      <tr>
        <td style="padding:16px 30px;border-top:1px solid ${BRAND.border};font-size:11px;color:#94a3b8;">Correo automático de DataNexus Platform. No respondas a este mensaje.</td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Versión en texto plano con la misma información, para clientes sin HTML. */
export function renderEmailText(options: EmailLayoutOptions): string {
  const lines: string[] = [options.title, '', ...options.paragraphs.flatMap((paragraph) => [paragraph, ''])];
  if (options.details?.length) {
    lines.push(...options.details.map((detail) => `${detail.label}: ${detail.value}`), '');
  }
  if (options.action) lines.push(`${options.action.label}: ${assertSafeEmailUrl(options.action.url)}`, '');
  if (options.footnote) lines.push(options.footnote, '');
  lines.push('— Equipo DataNexus');
  return lines.join('\n');
}

/** Atajo para las plantillas: asunto + HTML + texto a partir de las mismas opciones. */
export function renderEmail(subject: string, options: EmailLayoutOptions): RenderedEmail {
  return { subject, html: renderEmailLayout(options), text: renderEmailText(options) };
}
