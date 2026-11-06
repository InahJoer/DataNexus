import type { RenderedEmail } from './password-reset.template.js';

export interface InvitationEmailData {
  name: string;
  inviterName: string;
  workspaceName: string;
  roleLabel: string;
  acceptUrl: string;
  expiresInHours: number;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

/** Correo de invitación a un workspace (RF-06). */
export function renderInvitationEmail(data: InvitationEmailData): RenderedEmail {
  const name = escapeHtml(data.name);
  const inviter = escapeHtml(data.inviterName);
  const workspace = escapeHtml(data.workspaceName);
  const role = escapeHtml(data.roleLabel);
  const url = escapeHtml(data.acceptUrl);
  const hours = data.expiresInHours;

  const text = [
    `Hola ${data.name},`,
    '',
    `${data.inviterName} te invitó a unirte a "${data.workspaceName}" en DataNexus con el rol ${data.roleLabel}.`,
    `Abre este enlace para crear tu contraseña y activar tu cuenta (vence en ${hours} horas y solo puede usarse una vez):`,
    '',
    data.acceptUrl,
    '',
    'Si no esperabas esta invitación, ignora este correo.',
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
          <h1 style="margin:0 0 16px;font-size:20px;color:#1f4e78;">Te invitaron a ${workspace}</h1>
          <p style="margin:0 0 12px;line-height:1.5;">Hola ${name},</p>
          <p style="margin:0 0 20px;line-height:1.5;"><strong>${inviter}</strong> te invitó a unirte a <strong>${workspace}</strong> con el rol <strong>${role}</strong>. El enlace vence en <strong>${hours} horas</strong> y solo puede usarse una vez.</p>
          <p style="margin:0 0 24px;">
            <a href="${url}" style="display:inline-block;padding:12px 20px;background:#1f4e78;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Aceptar invitación</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.5;">Si el botón no funciona, copia este enlace en tu navegador:</p>
          <p style="margin:0 0 20px;font-size:13px;word-break:break-all;"><a href="${url}" style="color:#1f4e78;">${url}</a></p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">Si no esperabas esta invitación, ignora este correo.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: `Invitación a ${data.workspaceName} en DataNexus`, text, html };
}
