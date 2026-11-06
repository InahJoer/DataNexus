import { renderEmail, type RenderedEmail } from './email-layout.js';

export interface InvitationEmailData {
  name: string;
  inviterName: string;
  workspaceName: string;
  roleLabel: string;
  acceptUrl: string;
  expiresInHours: number;
}

/** Correo de invitación a un workspace (RF-06). */
export function renderInvitationEmail(data: InvitationEmailData): RenderedEmail {
  const hours = data.expiresInHours;
  return renderEmail(`Invitación a ${data.workspaceName} en DataNexus`, {
    title: `Te invitaron a ${data.workspaceName}`,
    eyebrow: 'Invitación al workspace',
    preheader: `${data.inviterName} te invitó con el rol ${data.roleLabel}.`,
    paragraphs: [
      `Hola ${data.name},`,
      `${data.inviterName} te invitó a unirte a "${data.workspaceName}" en DataNexus con el rol ${data.roleLabel}.`,
      `Abre el enlace para crear tu contraseña y activar tu cuenta. Vence en ${hours} horas y solo puede usarse una vez.`,
    ],
    details: [
      { label: 'Workspace', value: data.workspaceName },
      { label: 'Rol', value: data.roleLabel },
    ],
    action: { label: 'Aceptar invitación', url: data.acceptUrl },
    footnote: 'Si no esperabas esta invitación, ignora este correo.',
  });
}
