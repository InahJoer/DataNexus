import { renderEmail, type RenderedEmail } from './email-layout.js';

export type { RenderedEmail } from './email-layout.js';

export interface PasswordResetEmailData {
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}

/** Correo de recuperación de contraseña (RF-03). */
export function renderPasswordResetEmail(data: PasswordResetEmailData): RenderedEmail {
  const minutes = data.expiresInMinutes;
  return renderEmail('Restablece tu contraseña de DataNexus', {
    title: 'Restablece tu contraseña',
    eyebrow: 'Seguridad de la cuenta',
    preheader: `El enlace vence en ${minutes} minutos.`,
    paragraphs: [
      `Hola ${data.name},`,
      'Recibimos una solicitud para restablecer la contraseña de tu cuenta de DataNexus.',
      `Abre el enlace para elegir una nueva contraseña. Vence en ${minutes} minutos y solo puede usarse una vez.`,
    ],
    action: { label: 'Elegir nueva contraseña', url: data.resetUrl },
    footnote: 'Si no solicitaste este cambio, ignora este correo: tu contraseña actual sigue siendo válida.',
  });
}
