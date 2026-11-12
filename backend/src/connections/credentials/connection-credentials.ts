import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type { TipoMotor } from '../../common/tipo-motor.js';
import {
  FirestoreCredentialsDto,
  MongoCredentialsDto,
  MysqlCredentialsDto,
  PostgresCredentialsDto,
  SqlServerCredentialsDto,
} from './credential-dtos.js';
import { assertTlsPolicy } from './tls-policy.js';

/** Versión del formato cifrado. 1 = cadena de conexión libre (legado); 2 = JSON estructurado. */
export const LEGACY_CREDENTIALS_VERSION = 1;
export const STRUCTURED_CREDENTIALS_VERSION = 2;

export const DEFAULT_PORTS = { POSTGRESQL: 5432, MYSQL: 3306, SQLSERVER: 1433 } as const;
export const FIRESTORE_HOST = 'firestore.googleapis.com';
export const FIRESTORE_DEFAULT_DATABASE = '(default)';

export interface SqlCredentials {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}
export interface PostgresCredentials extends SqlCredentials {
  ssl: boolean;
}
export type MysqlCredentials = PostgresCredentials;
export interface SqlServerCredentials extends SqlCredentials {
  encrypt: boolean;
  trustServerCertificate: boolean;
}
export interface MongoCredentials {
  uri: string;
  database: string;
}
/** Campos de la cuenta de servicio que se conservan; el resto del JSON se descarta. */
export interface ServiceAccount {
  type: 'service_account';
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  client_id?: string;
}
export interface FirestoreCredentials {
  serviceAccount: ServiceAccount;
  databaseId: string;
}

export interface CredentialsByEngine {
  POSTGRESQL: PostgresCredentials;
  MYSQL: MysqlCredentials;
  SQLSERVER: SqlServerCredentials;
  MONGODB: MongoCredentials;
  FIRESTORE: FirestoreCredentials;
}
export type ConnectionCredentials = CredentialsByEngine[TipoMotor];

/** Metadatos no secretos que se guardan en claro y se devuelven al cliente. */
export interface ConnectionMetadata {
  host: string;
  dbName: string;
  detalles: Record<string, string | number | boolean>;
}

const DTO_BY_ENGINE = {
  POSTGRESQL: PostgresCredentialsDto,
  MYSQL: MysqlCredentialsDto,
  SQLSERVER: SqlServerCredentialsDto,
  MONGODB: MongoCredentialsDto,
  FIRESTORE: FirestoreCredentialsDto,
} as const;

/** Clase DTO de credenciales de cada motor (para Swagger y validación). */
export function credentialsDtoFor(tipoMotor: TipoMotor) {
  return DTO_BY_ENGINE[tipoMotor];
}

function flattenErrors(errors: ValidationError[], prefix = 'credenciales'): string[] {
  return errors.flatMap((error) => {
    const path = `${prefix}.${error.property}`;
    const own = Object.values(error.constraints ?? {}).map((message) =>
      message.startsWith('property ') ? `${path}: campo no permitido para este motor` : `${path}: ${message}`,
    );
    return [...own, ...flattenErrors(error.children ?? [], path)];
  });
}

const PRIVATE_KEY_PATTERN = /^-----BEGIN (RSA )?PRIVATE KEY-----\s[\s\S]+\s-----END (RSA )?PRIVATE KEY-----\s*$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Valida el JSON de Service Account de Firebase y devuelve solo los campos necesarios.
 * Rechaza otros tipos de credencial (p. ej. authorized_user) para no aceptar cuentas personales.
 */
export function parseServiceAccount(value: unknown): ServiceAccount {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('El Service Account debe ser un objeto JSON');
  }
  const account = value as Record<string, unknown>;
  const errors: string[] = [];
  const text = (key: string) => (typeof account[key] === 'string' ? (account[key] as string).trim() : '');

  if (account.type !== 'service_account') errors.push('type debe ser "service_account"');
  if (!PROJECT_ID_PATTERN.test(text('project_id'))) errors.push('project_id falta o no es válido');
  if (!EMAIL_PATTERN.test(text('client_email'))) errors.push('client_email falta o no es un correo válido');
  // Algunos exportadores escapan los saltos de línea de la clave.
  // La clave se conserva tal cual (sin recortar), salvo convertir "\n" escapados en saltos reales.
  const privateKey = typeof account.private_key === 'string' ? account.private_key.replace(/\\n/g, '\n') : '';
  if (!PRIVATE_KEY_PATTERN.test(privateKey) || privateKey.length > 8192) {
    errors.push('private_key falta o no es una clave privada PEM');
  }
  if (errors.length > 0) {
    throw new BadRequestException(errors.map((error) => `Service Account: ${error}`));
  }

  const result: ServiceAccount = {
    type: 'service_account',
    project_id: text('project_id'),
    private_key: privateKey,
    client_email: text('client_email'),
  };
  if (text('private_key_id')) result.private_key_id = text('private_key_id');
  if (text('client_id')) result.client_id = text('client_id');
  return result;
}

/** Lee el archivo subido (en memoria) como JSON de Service Account. */
export function parseServiceAccountFile(buffer: Buffer): ServiceAccount {
  let json: unknown;
  try {
    json = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new BadRequestException('El archivo no es un JSON válido');
  }
  return parseServiceAccount(json);
}

/**
 * Valida las credenciales de un motor con su DTO (sin campos extra) y completa los valores por defecto.
 * Lanza 400 con mensajes `credenciales.<campo>: ...`.
 */
export async function validateCredentials<T extends TipoMotor>(
  tipoMotor: T,
  raw: unknown,
): Promise<CredentialsByEngine[T]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException(['credenciales debe ser un objeto con los datos de conexión del motor']);
  }
  const dto = plainToInstance(DTO_BY_ENGINE[tipoMotor] as new () => object, raw);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true, stopAtFirstError: true });
  if (errors.length > 0) throw new BadRequestException(flattenErrors(errors));

  const credentials = buildCredentials(tipoMotor, dto as Record<string, unknown>);
  assertTlsPolicy(tipoMotor, credentials);
  return credentials;
}

function buildCredentials<T extends TipoMotor>(tipoMotor: T, input: Record<string, unknown>): CredentialsByEngine[T] {
  switch (tipoMotor) {
    case 'POSTGRESQL':
    case 'MYSQL':
      return {
        host: input.host as string,
        port: (input.port as number | undefined) ?? DEFAULT_PORTS[tipoMotor as 'POSTGRESQL' | 'MYSQL'],
        database: input.database as string,
        username: input.username as string,
        password: input.password as string,
        ssl: (input.ssl as boolean | undefined) ?? false,
      } as CredentialsByEngine[T];
    case 'SQLSERVER':
      return {
        host: input.host as string,
        port: (input.port as number | undefined) ?? DEFAULT_PORTS.SQLSERVER,
        database: input.database as string,
        username: input.username as string,
        password: input.password as string,
        encrypt: (input.encrypt as boolean | undefined) ?? true,
        trustServerCertificate: (input.trustServerCertificate as boolean | undefined) ?? false,
      } as CredentialsByEngine[T];
    case 'MONGODB':
      return { uri: input.uri as string, database: input.database as string } as CredentialsByEngine[T];
    case 'FIRESTORE':
      return {
        serviceAccount: parseServiceAccount(input.serviceAccount),
        databaseId: (input.databaseId as string | undefined) ?? FIRESTORE_DEFAULT_DATABASE,
      } as CredentialsByEngine[T];
    default:
      throw new BadRequestException(`Motor no soportado: ${String(tipoMotor)}`);
  }
}

/** Texto en claro que se cifra y guarda en connectionStringEncriptada (versión 2). */
export function serializeCredentials(tipoMotor: TipoMotor, credentials: ConnectionCredentials): string {
  return JSON.stringify({ v: STRUCTURED_CREDENTIALS_VERSION, tipoMotor, credentials });
}

/** Lee las credenciales descifradas de la versión 2. Devuelve null si el texto es una cadena legado. */
export function parseStoredCredentials(
  decrypted: string,
): { tipoMotor: TipoMotor; credentials: ConnectionCredentials } | null {
  if (!decrypted.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(decrypted) as { v?: unknown; tipoMotor?: TipoMotor; credentials?: ConnectionCredentials };
    if (parsed.v !== STRUCTURED_CREDENTIALS_VERSION || !parsed.tipoMotor || !parsed.credentials) return null;
    return { tipoMotor: parsed.tipoMotor, credentials: parsed.credentials };
  } catch {
    return null;
  }
}

const hostForUrl = (host: string) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
const braces = (value: string | number) => `{${String(value).replace(/}/g, '}}')}}`;

/**
 * Convierte las credenciales al formato que esperan los adaptadores de cada driver.
 * Las cadenas legado (versión 1) se devuelven tal cual, así que las conexiones existentes siguen funcionando.
 */
export function toDriverConnectionString(decrypted: string): string {
  const stored = parseStoredCredentials(decrypted);
  if (!stored) return decrypted;

  switch (stored.tipoMotor) {
    case 'POSTGRESQL':
    case 'MYSQL': {
      const c = stored.credentials as PostgresCredentials;
      const scheme = stored.tipoMotor === 'POSTGRESQL' ? 'postgresql' : 'mysql';
      const url = new URL(`${scheme}://${hostForUrl(c.host)}:${c.port}`);
      url.username = encodeURIComponent(c.username);
      url.password = encodeURIComponent(c.password);
      url.pathname = `/${encodeURIComponent(c.database)}`;
      if (c.ssl) url.searchParams.set(stored.tipoMotor === 'POSTGRESQL' ? 'sslmode' : 'ssl', stored.tipoMotor === 'POSTGRESQL' ? 'require' : 'true');
      return url.toString();
    }
    case 'SQLSERVER': {
      const c = stored.credentials as SqlServerCredentials;
      return [
        `Server=${braces(`${c.host},${c.port}`)}`,
        `Database=${braces(c.database)}`,
        `User Id=${braces(c.username)}`,
        `Password=${braces(c.password)}`,
        `Encrypt=${c.encrypt}`,
        `TrustServerCertificate=${c.trustServerCertificate}`,
      ].join(';');
    }
    case 'MONGODB':
      return (stored.credentials as MongoCredentials).uri;
    case 'FIRESTORE':
      return JSON.stringify((stored.credentials as FirestoreCredentials).serviceAccount);
    default:
      return decrypted;
  }
}

/** Hosts de una URI de MongoDB, sin usuario ni contraseña. */
function mongoHosts(uri: string): string {
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const authority = withoutScheme.split(/[/?]/, 1)[0] ?? '';
  return authority.slice(authority.lastIndexOf('@') + 1).slice(0, 255);
}

/** Metadatos públicos: lo que se guarda en host, dbName y detalles. Nunca incluye secretos. */
export function describeCredentials(tipoMotor: TipoMotor, credentials: ConnectionCredentials): ConnectionMetadata {
  switch (tipoMotor) {
    case 'POSTGRESQL':
    case 'MYSQL': {
      const c = credentials as PostgresCredentials;
      return { host: c.host, dbName: c.database, detalles: { puerto: c.port, usuario: c.username, ssl: c.ssl } };
    }
    case 'SQLSERVER': {
      const c = credentials as SqlServerCredentials;
      return {
        host: c.host,
        dbName: c.database,
        detalles: {
          puerto: c.port,
          usuario: c.username,
          encrypt: c.encrypt,
          trustServerCertificate: c.trustServerCertificate,
        },
      };
    }
    case 'MONGODB': {
      const c = credentials as MongoCredentials;
      return { host: mongoHosts(c.uri), dbName: c.database, detalles: { srv: c.uri.startsWith('mongodb+srv://') } };
    }
    case 'FIRESTORE': {
      const c = credentials as FirestoreCredentials;
      return {
        host: FIRESTORE_HOST,
        dbName: c.databaseId,
        detalles: { projectId: c.serviceAccount.project_id, clientEmail: c.serviceAccount.client_email },
      };
    }
    default:
      throw new BadRequestException(`Motor no soportado: ${String(tipoMotor)}`);
  }
}
