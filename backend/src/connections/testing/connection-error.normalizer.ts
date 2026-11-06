export const CONNECTION_ERROR_CODES = [
  'TIMEOUT',
  'HOST_NOT_FOUND',
  'CONNECTION_REFUSED',
  'NETWORK_ERROR',
  'TLS_ERROR',
  'AUTH_FAILED',
  'DATABASE_NOT_FOUND',
  'PERMISSION_DENIED',
  'INVALID_CONFIGURATION',
  'UNSUPPORTED_ENGINE',
  'UNKNOWN',
] as const;

export type ConnectionErrorCode = (typeof CONNECTION_ERROR_CODES)[number];

export interface NormalizedConnectionError {
  code: ConnectionErrorCode;
  message: string;
}

type Motor = 'POSTGRESQL' | 'MYSQL' | 'SQLSERVER' | 'FIRESTORE' | 'OTHER';

const ENGINE_LABEL: Record<Motor, string> = {
  POSTGRESQL: 'PostgreSQL',
  MYSQL: 'MySQL',
  SQLSERVER: 'SQL Server',
  FIRESTORE: 'Firestore',
  OTHER: 'la base de datos',
};

/** Señales extraídas de la cadena de errores. Nunca se devuelven al cliente. */
interface ErrorSignals {
  codes: Set<string>;
  numbers: Set<number>;
  text: string;
}

const NETWORK_CODES: Record<string, ConnectionErrorCode> = {
  ENOTFOUND: 'HOST_NOT_FOUND',
  EAI_AGAIN: 'HOST_NOT_FOUND',
  EINSTLOOKUP: 'HOST_NOT_FOUND',
  ECONNREFUSED: 'CONNECTION_REFUSED',
  ETIMEDOUT: 'TIMEOUT',
  ESOCKETTIMEDOUT: 'TIMEOUT',
  ETIMEOUT: 'TIMEOUT',
  ECONNRESET: 'NETWORK_ERROR',
  EHOSTUNREACH: 'NETWORK_ERROR',
  ENETUNREACH: 'NETWORK_ERROR',
  EPIPE: 'NETWORK_ERROR',
  ECONNCLOSED: 'NETWORK_ERROR',
  PROTOCOL_CONNECTION_LOST: 'NETWORK_ERROR',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS_ERROR',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS_ERROR',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS_ERROR',
  CERT_HAS_EXPIRED: 'TLS_ERROR',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS_ERROR',
  HANDSHAKE_SSL_ERROR: 'TLS_ERROR',
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION',
  ERR_INVALID_URL: 'INVALID_CONFIGURATION',
};

function toMotor(tipoMotor: string): Motor {
  const motor = tipoMotor.toLowerCase().replace(/[^a-z]/g, '');
  if (motor === 'postgres' || motor === 'postgresql') return 'POSTGRESQL';
  if (motor === 'mysql' || motor === 'mariadb') return 'MYSQL';
  if (motor === 'sqlserver' || motor === 'mssql') return 'SQLSERVER';
  if (motor === 'firestore' || motor === 'firebase' || motor === 'cloudfirestore') return 'FIRESTORE';
  return 'OTHER';
}

/** Recorre error, cause, originalError y errors[] (AggregateError, tedious). */
function collectSignals(error: unknown): ErrorSignals {
  const signals: ErrorSignals = { codes: new Set(), numbers: new Set(), text: '' };
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  const texts: string[] = [];

  while (queue.length > 0 && seen.size < 25) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;

    for (const key of ['code', 'sqlState', 'reason']) {
      if (typeof record[key] === 'string') signals.codes.add(record[key] as string);
    }
    for (const key of ['code', 'errno', 'number']) {
      if (typeof record[key] === 'number') signals.numbers.add(record[key] as number);
    }
    if (typeof record.message === 'string') texts.push(record.message);

    queue.push(record.cause, record.originalError);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
    if (Array.isArray(record.precedingErrors)) queue.push(...record.precedingErrors);
  }
  signals.text = texts.join(' | ').toLowerCase();
  return signals;
}

function classifyNetwork(signals: ErrorSignals): ConnectionErrorCode | undefined {
  for (const code of signals.codes) {
    const mapped = NETWORK_CODES[code];
    if (mapped) return mapped;
    if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) return 'TLS_ERROR';
  }
  if (/timeout|timed out/.test(signals.text)) return 'TIMEOUT';
  if (/getaddrinfo|could not resolve|name or service not known/.test(signals.text)) return 'HOST_NOT_FOUND';
  if (/ssl|tls|certificate/.test(signals.text)) return 'TLS_ERROR';
  return undefined;
}

function classifyPostgres(signals: ErrorSignals): ConnectionErrorCode | undefined {
  const { codes, text } = signals;
  if (codes.has('28P01') || codes.has('28000')) return 'AUTH_FAILED';
  if (codes.has('3D000')) return 'DATABASE_NOT_FOUND';
  if (codes.has('42501')) return 'PERMISSION_DENIED';
  if (codes.has('53300')) return 'NETWORK_ERROR';
  if (/password authentication failed|no pg_hba\.conf entry|sasl/.test(text)) return 'AUTH_FAILED';
  if (/does not support ssl/.test(text)) return 'TLS_ERROR';
  return undefined;
}

function classifyMysql(signals: ErrorSignals): ConnectionErrorCode | undefined {
  const { codes, numbers } = signals;
  if (codes.has('ER_ACCESS_DENIED_ERROR') || numbers.has(1045)) return 'AUTH_FAILED';
  if (codes.has('ER_NOT_SUPPORTED_AUTH_MODE') || numbers.has(1251)) return 'AUTH_FAILED';
  if (codes.has('ER_BAD_DB_ERROR') || numbers.has(1049)) return 'DATABASE_NOT_FOUND';
  if (codes.has('ER_DBACCESS_DENIED_ERROR') || numbers.has(1044)) return 'PERMISSION_DENIED';
  if (codes.has('ER_HOST_NOT_PRIVILEGED') || numbers.has(1130)) return 'PERMISSION_DENIED';
  if (codes.has('ER_CON_COUNT_ERROR') || numbers.has(1040)) return 'NETWORK_ERROR';
  return undefined;
}

function classifySqlServer(signals: ErrorSignals): ConnectionErrorCode | undefined {
  const { codes, numbers, text } = signals;
  // 4060: la base de datos no existe o el login no tiene acceso a ella.
  if (numbers.has(4060) || /cannot open database/.test(text)) return 'DATABASE_NOT_FOUND';
  if (numbers.has(18456) || codes.has('ELOGIN')) return 'AUTH_FAILED';
  if (numbers.has(916) || numbers.has(229)) return 'PERMISSION_DENIED';
  if (codes.has('EINSTLOOKUP')) return 'HOST_NOT_FOUND';
  if (codes.has('ETIMEOUT')) return 'TIMEOUT';
  if (codes.has('ECONFIG') || codes.has('EINVALIDSTATE')) return 'INVALID_CONFIGURATION';
  return undefined;
}

/** Códigos gRPC devueltos por la API de Firestore. */
function classifyFirestore(signals: ErrorSignals): ConnectionErrorCode | undefined {
  const { numbers, text, codes } = signals;
  if (numbers.has(16) || /invalid_grant|unauthenticated|invalid jwt/.test(text)) return 'AUTH_FAILED';
  if (/decoder routines|private key|pem/.test(text)) return 'INVALID_CONFIGURATION';
  if (numbers.has(7)) return 'PERMISSION_DENIED';
  if (numbers.has(5)) return 'DATABASE_NOT_FOUND';
  if (numbers.has(4)) return 'TIMEOUT';
  if (numbers.has(14)) return 'NETWORK_ERROR';
  if (codes.has('ENOTFOUND')) return 'NETWORK_ERROR';
  return undefined;
}

function messageFor(code: ConnectionErrorCode, motor: Motor, timeoutMs?: number, rawMotor = ''): string {
  const engine = ENGINE_LABEL[motor];
  const isFirestore = motor === 'FIRESTORE';
  switch (code) {
    case 'TIMEOUT':
      if (isFirestore) {
        return 'Firestore no respondió a tiempo. Revise la conectividad con Google Cloud y que la cuenta de servicio sea válida.';
      }
      return timeoutMs
        ? `${engine} no respondió en ${timeoutMs / 1000} segundos. Revise el host, el puerto y el firewall.`
        : `${engine} no respondió a tiempo. Revise el host, el puerto y el firewall.`;
    case 'HOST_NOT_FOUND':
      return 'No se encontró el host. Verifique el nombre del servidor o la dirección IP.';
    case 'CONNECTION_REFUSED':
      return `El servidor rechazó la conexión. Verifique que ${engine} esté en ejecución y que el puerto sea correcto.`;
    case 'NETWORK_ERROR':
      return isFirestore
        ? 'No se pudo contactar el servicio de Firestore. Revise la conectividad de red e inténtelo de nuevo.'
        : `Se perdió la conexión con ${engine}. Revise la red, el firewall o el límite de conexiones del servidor.`;
    case 'TLS_ERROR':
      return 'Falló la negociación SSL/TLS. Revise la configuración de cifrado y el certificado del servidor.';
    case 'AUTH_FAILED':
      return isFirestore
        ? 'Las credenciales de la cuenta de servicio fueron rechazadas. Genere una nueva clave e inténtelo de nuevo.'
        : 'Usuario o contraseña incorrectos.';
    case 'DATABASE_NOT_FOUND':
      return isFirestore
        ? 'La base de datos de Firestore no existe en el proyecto indicado.'
        : 'La base de datos indicada no existe o el usuario no tiene acceso a ella.';
    case 'PERMISSION_DENIED':
      return isFirestore
        ? 'La cuenta de servicio no tiene permisos de lectura sobre Firestore.'
        : 'El usuario no tiene permisos suficientes sobre la base de datos.';
    case 'INVALID_CONFIGURATION':
      return isFirestore
        ? 'El JSON de la cuenta de servicio es inválido o le faltan project_id, client_email o private_key.'
        : `La cadena de conexión de ${engine} tiene un formato inválido.`;
    case 'UNSUPPORTED_ENGINE':
      return `La prueba de conexión aún no está disponible para ${rawMotor || 'este motor'}.`;
    default:
      return `No se pudo conectar con ${engine}. Revise los datos de conexión e inténtelo de nuevo.`;
  }
}

export function connectionError(
  code: ConnectionErrorCode,
  tipoMotor: string,
  timeoutMs?: number,
): NormalizedConnectionError {
  return { code, message: messageFor(code, toMotor(tipoMotor), timeoutMs, tipoMotor) };
}

/**
 * Traduce el error del driver a un código y mensaje estables. El mensaje se
 * redacta desde cero: nunca reutiliza el texto del driver, que puede incluir
 * hosts, usuarios o la cadena de conexión.
 */
export function normalizeConnectionError(
  error: unknown,
  tipoMotor: string,
  timeoutMs?: number,
): NormalizedConnectionError {
  const motor = toMotor(tipoMotor);
  const signals = collectSignals(error);
  const engineSpecific = {
    POSTGRESQL: classifyPostgres,
    MYSQL: classifyMysql,
    SQLSERVER: classifySqlServer,
    FIRESTORE: classifyFirestore,
    OTHER: () => undefined,
  }[motor](signals);
  const code = engineSpecific ?? classifyNetwork(signals) ?? 'UNKNOWN';
  return { code, message: messageFor(code, motor, timeoutMs, tipoMotor) };
}
