/**
 * Certificado de autoridad (CA) propio para conexiones TLS de PostgreSQL y MySQL.
 *
 * Proveedores como Supabase, Aiven o RDS firman sus servidores con una CA que no está en el almacén de Node, así que
 * `sslmode=require` (que node-postgres trata como verify-full) falla con SELF_SIGNED_CERT_IN_CHAIN. Con el PEM de esa
 * CA la conexión sigue cifrada y además se verifica el servidor, sin desactivar la validación.
 *
 * El PEM viaja dentro de la cadena interna del driver (nunca sale de la API) como parámetro `sslca` en base64url.
 */
export const CA_URL_PARAM = 'sslca';
export const MAX_CA_CERTIFICATE_LENGTH = 16_384;

/** Uno o varios certificados PEM, sin claves privadas. */
export const CA_CERTIFICATE_PATTERN =
  /^(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)+$/;

export function encodeCaCertificate(pem: string): string {
  return Buffer.from(pem, 'utf8').toString('base64url');
}

/** Lee y quita `sslca` de la URL. Devuelve el PEM o undefined si no hay. */
export function takeCaCertificate(url: URL): string | undefined {
  const encoded = url.searchParams.get(CA_URL_PARAM);
  url.searchParams.delete(CA_URL_PARAM);
  return encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : undefined;
}

/**
 * Configuración de node-postgres. Con CA propia se quita `sslmode` de la URL: pg aplica los parámetros de la cadena
 * por encima de la opción `ssl`, y `sslmode=require` reemplazaría la CA por la verificación por defecto.
 */
export function postgresClientConfig(url: URL): { connectionString: string; ssl?: { ca: string; rejectUnauthorized: true } } {
  const ca = takeCaCertificate(url);
  if (!ca) return { connectionString: url.toString() };
  url.searchParams.delete('sslmode');
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}

/** Opción `ssl` de mysql2: verificación por defecto, o con la CA propia si la hay. */
export function mysqlSslOption(url: URL): { ca?: string; rejectUnauthorized?: true } | undefined {
  const ca = takeCaCertificate(url);
  if (url.searchParams.get('ssl') !== 'true') return undefined;
  return ca ? { ca, rejectUnauthorized: true } : {};
}
