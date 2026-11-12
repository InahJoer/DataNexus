import { BadRequestException } from '@nestjs/common';
import type { TipoMotor } from '../../common/tipo-motor.js';
import type { MongoCredentials, PostgresCredentials, SqlServerCredentials } from './connection-credentials.js';

/**
 * RNF-02 / issue #52: TLS 1.2+ hacia las bases externas.
 * Por defecto se exige en producción; EXTERNAL_DB_REQUIRE_TLS=true|false lo fuerza en cualquier entorno.
 */
export function externalTlsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.EXTERNAL_DB_REQUIRE_TLS?.trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return env.NODE_ENV === 'production';
}

/** true si la URI de MongoDB usa TLS: `mongodb+srv://` lo activa por defecto, `tls`/`ssl` lo fijan explícitamente. */
export function mongoUriUsesTls(uri: string): boolean {
  const query = uri.includes('?') ? new URLSearchParams(uri.slice(uri.indexOf('?') + 1)) : new URLSearchParams();
  const explicit = (query.get('tls') ?? query.get('ssl'))?.toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return uri.startsWith('mongodb+srv://');
}

/**
 * Rechaza (400) credenciales sin cifrado de transporte cuando la política lo exige.
 * Firestore siempre usa TLS (gRPC sobre HTTPS), así que no necesita comprobación.
 */
export function assertTlsPolicy(tipoMotor: TipoMotor, credentials: unknown, required = externalTlsRequired()): void {
  if (!required) return;
  const reject = (field: string, hint: string) => {
    throw new BadRequestException([`credenciales.${field}: la política de seguridad exige conexiones cifradas con TLS (${hint})`]);
  };
  switch (tipoMotor) {
    case 'POSTGRESQL':
    case 'MYSQL':
      if (!(credentials as PostgresCredentials).ssl) reject('ssl', 'activa ssl');
      return;
    case 'SQLSERVER': {
      const c = credentials as SqlServerCredentials;
      if (!c.encrypt) reject('encrypt', 'activa encrypt');
      if (c.trustServerCertificate) reject('trustServerCertificate', 'el certificado del servidor debe validarse');
      return;
    }
    case 'MONGODB':
      if (!mongoUriUsesTls((credentials as MongoCredentials).uri)) reject('uri', 'usa mongodb+srv:// o añade tls=true');
      return;
    default:
      return;
  }
}
