import { registerDecorator, type ValidationOptions } from 'class-validator';

/** Proveedores de correo personal que no se aceptan como correo corporativo (RF-01). */
export const DEFAULT_BLOCKED_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.es',
  'outlook.com',
  'outlook.es',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.es',
  'ymail.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
] as const;

/**
 * Dominios bloqueados vigentes. BLOCKED_EMAIL_DOMAINS (lista separada por comas) reemplaza a la
 * lista por defecto; ALLOW_PERSONAL_EMAILS=true desactiva la regla (útil en demos).
 */
export function getBlockedEmailDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.ALLOW_PERSONAL_EMAILS === 'true') return [];
  const custom = env.BLOCKED_EMAIL_DOMAINS?.trim();
  if (!custom) return [...DEFAULT_BLOCKED_EMAIL_DOMAINS];
  return custom
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export function isCorporateEmail(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof email !== 'string' || !email.includes('@')) return false;
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  return !getBlockedEmailDomains(env).some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

/** Decorador de class-validator: rechaza correos de proveedores personales. */
export function IsCorporateEmail(options: ValidationOptions = {}) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isCorporateEmail',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isCorporateEmail(value),
        defaultMessage: () =>
          'Usa un correo corporativo de tu empresa; no se aceptan correos personales como Gmail, Hotmail u Outlook.',
      },
    });
  };
}
