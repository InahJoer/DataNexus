import { getBlockedEmailDomains } from '../auth/validators/corporate-email.js';

/** Límites de la configuración del workspace (evitan payloads desmedidos). */
export const MAX_ALLOWED_DOMAINS = 50;
export const MAX_SENSITIVE_FIELDS = 200;

const DOMAIN_REGEX = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
/** Nombre de campo de una tabla o colección; admite rutas anidadas (cliente.email). */
const FIELD_REGEX = /^[a-z_][a-z0-9_$-]*(\.[a-z_][a-z0-9_$-]*)*$/;

/** Resultado de normalizar una lista: valores limpios o los valores rechazados. */
export type NormalizeResult = { ok: true; values: string[] } | { ok: false; invalid: string[] };

/** Zona horaria IANA reconocida por el runtime (America/Managua, UTC, Europe/Madrid...). */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Normaliza los dominios permitidos: minúsculas, sin "@" inicial y sin duplicados.
 * Rechaza formatos inválidos y proveedores de correo personal (RF-01), que nunca podrían invitarse.
 */
export function normalizeAllowedDomains(
  domains: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): NormalizeResult {
  const blocked = getBlockedEmailDomains(env);
  const values = dedupe(domains.map((domain) => domain.trim().toLowerCase().replace(/^@/, '')));
  const invalid = values.filter(
    (domain) =>
      !DOMAIN_REGEX.test(domain) ||
      blocked.some((personal) => domain === personal || domain.endsWith(`.${personal}`)),
  );
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, values };
}

/** Normaliza los campos sensibles: minúsculas (la comparación no distingue mayúsculas) y sin duplicados. */
export function normalizeSensitiveFields(fields: readonly string[]): NormalizeResult {
  const values = dedupe(fields.map((field) => field.trim().toLowerCase()));
  const invalid = values.filter((field) => field.length > 128 || !FIELD_REGEX.test(field));
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, values };
}

/**
 * Indica si el correo pertenece a uno de los dominios permitidos (o a un subdominio).
 * Una lista vacía significa que el workspace no restringe dominios.
 */
export function isEmailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}
