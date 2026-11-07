/**
 * Orígenes que pueden llamar a la API desde el navegador (CORS, issue #6).
 * - Siempre: los configurados (FRONTEND_URL, API_PUBLIC_URL) y localhost:3000/3001.
 * - Fuera de producción, además, cualquier puerto de localhost y de las IP de redes privadas (192.168.x.x, 10.x.x.x,
 *   172.16–31.x.x): así la app se puede abrir desde otro equipo o un celular en la misma red durante el desarrollo o
 *   una demo. En producción solo cuentan los orígenes configurados.
 */
const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

export function isAllowedOrigin(origin: string | undefined, configured: readonly string[], isProduction: boolean): boolean {
  // Herramientas locales o llamadas servidor a servidor no envían Origin.
  if (!origin) return true;
  if (configured.includes(origin)) return true;
  if (isProduction) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && PRIVATE_HOST.test(url.hostname);
  } catch {
    return false;
  }
}
