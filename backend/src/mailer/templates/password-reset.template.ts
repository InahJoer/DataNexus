export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface PasswordResetEmailData {
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

/** Correo de recuperación de contraseña (RF-03). */
export function renderPasswordResetEmail(data: PasswordResetEmailData): RenderedEmail {
  const name = escapeHtml(data.name);
  const url = escapeHtml(data.resetUrl);
  const minutes = data.expiresInMinutes;

  const text = [
    `Hola ${data.name},`,
    '',
    'Recibimos una solicitud para restablecer la contraseña de tu cuenta de DataNexus.',
    `Abre este enlace para elegir una nueva contraseña (vence en ${minutes} minutos y solo puede usarse una vez):`,
    '',
    data.resetUrl,
    '',
    'Si no solicitaste este cambio, ignora este correo: tu contraseña actual sigue siendo válida.',
    '',
    '— Equipo DataNexus',
  ].join('\n');

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f4f6f9;font-family:Segoe UI,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">
      <tr>
        <td style="padding:28px 32px;">
          <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;color:#6b7280;">DATANEXUS</p>
          <h1 style="margin:0 0 16px;font-size:20px;color:#1f4e78;">Restablece tu contraseña</h1>
          <p style="margin:0 0 12px;line-height:1.5;">Hola ${name},</p>
          <p style="margin:0 0 20px;line-height:1.5;">Recibimos una solicitud para restablecer la contraseña de tu cuenta. El enlace vence en <strong>${minutes} minutos</strong> y solo puede usarse una vez.</p>
          <p style="margin:0 0 24px;">
            <a href="${url}" style="display:inline-block;padding:12px 20px;background:#1f4e78;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Elegir nueva contraseña</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.5;">Si el botón no funciona, copia este enlace en tu navegador:</p>
          <p style="margin:0 0 20px;font-size:13px;word-break:break-all;"><a href="${url}" style="color:#1f4e78;">${url}</a></p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">Si no solicitaste este cambio, ignora este correo: tu contraseña actual sigue siendo válida.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: 'Restablece tu contraseña de DataNexus', text, html };
}
