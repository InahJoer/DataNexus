import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import sql from 'mssql';
import {
  describeCredentials,
  parseServiceAccount,
  parseServiceAccountFile,
  parseStoredCredentials,
  serializeCredentials,
  toDriverConnectionString,
  validateCredentials,
} from './connection-credentials.js';

const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
const serviceAccount = {
  type: 'service_account',
  project_id: 'datanexus-demo',
  private_key_id: 'abc123',
  private_key: PRIVATE_KEY,
  client_email: 'lector@datanexus-demo.iam.gserviceaccount.com',
  client_id: '1234567890',
  token_uri: 'https://oauth2.googleapis.com/token',
};

async function messages(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as { message: string | string[] };
    return Array.isArray(response.message) ? response.message : [response.message];
  }
  throw new Error('Se esperaba un error de validación');
}

describe('Credenciales estructuradas por motor', () => {
  describe('POSTGRESQL / MYSQL', () => {
    const base = { host: 'db.internal', database: 'analytics', username: 'lector', password: 'S3creta' };

    it.each([
      ['POSTGRESQL', 5432],
      ['MYSQL', 3306],
    ] as const)('%s completa el puerto por defecto y ssl=false', async (motor, port) => {
      await expect(validateCredentials(motor, base)).resolves.toEqual({ ...base, port, ssl: false });
    });

    it('acepta IPs y puertos explícitos', async () => {
      await expect(validateCredentials('POSTGRESQL', { ...base, host: '10.0.0.5', port: 6543 })).resolves.toMatchObject({
        host: '10.0.0.5',
        port: 6543,
      });
      await expect(validateCredentials('POSTGRESQL', { ...base, host: '::1' })).resolves.toMatchObject({ host: '::1' });
    });

    it('informa todos los campos faltantes', async () => {
      const errors = await messages(validateCredentials('POSTGRESQL', {}));
      for (const field of ['host', 'database', 'username', 'password']) {
        expect(errors.some((message) => message.startsWith(`credenciales.${field}:`)), field).toBe(true);
      }
      // Un mensaje por campo, y para un campo ausente es el de "requerido", no el de longitud.
      expect(errors).toHaveLength(4);
      expect(errors).toContain('credenciales.password: La contraseña es requerida');
      expect(errors).toContain('credenciales.database: La base de datos es requerida');
    });

    it.each([
      ['host con protocolo', { host: 'postgres://db.internal' }],
      ['host con ruta', { host: 'db.internal/x' }],
      ['puerto fuera de rango', { port: 70000 }],
      ['puerto no entero', { port: '5432' }],
      ['ssl no booleano', { ssl: 'yes' }],
    ])('rechaza %s', async (_label, override) => {
      await expect(validateCredentials('POSTGRESQL', { ...base, ...override })).rejects.toThrow(BadRequestException);
    });

    it('rechaza campos de otros motores', async () => {
      const errors = await messages(validateCredentials('MYSQL', { ...base, uri: 'mongodb://x' }));
      expect(errors).toContain('credenciales.uri: campo no permitido para este motor');
    });

    it('rechaza payloads que no son objeto', async () => {
      await expect(validateCredentials('POSTGRESQL', 'postgres://u:p@h/db')).rejects.toThrow(BadRequestException);
      await expect(validateCredentials('POSTGRESQL', null)).rejects.toThrow(BadRequestException);
    });
  });

  describe('SQLSERVER', () => {
    const base = { host: 'sql.internal', database: 'ventas', username: 'sa', password: 'P;a=s"s{x}' };

    it('usa Encrypt=true y TrustServerCertificate=false por defecto', async () => {
      await expect(validateCredentials('SQLSERVER', base)).resolves.toEqual({
        ...base,
        port: 1433,
        encrypt: true,
        trustServerCertificate: false,
      });
    });

    it('no acepta ssl (es de PostgreSQL/MySQL)', async () => {
      await expect(validateCredentials('SQLSERVER', { ...base, ssl: true })).rejects.toThrow(BadRequestException);
    });

    it('genera una cadena que mssql interpreta igual, aunque la contraseña tenga ; = " y llaves', async () => {
      const credentials = await validateCredentials('SQLSERVER', { ...base, username: 'sa;admin', port: 14330 });
      const config = sql.ConnectionPool.parseConnectionString(
        toDriverConnectionString(serializeCredentials('SQLSERVER', credentials)),
      );
      expect(config).toMatchObject({
        server: 'sql.internal',
        port: 14330,
        database: 'ventas',
        user: 'sa;admin',
        password: 'P;a=s"s{x}',
        options: { encrypt: true, trustServerCertificate: false },
      });
    });
  });

  describe('MONGODB', () => {
    it('valida el esquema de la URI', async () => {
      await expect(
        validateCredentials('MONGODB', { uri: 'mongodb+srv://u:p@cluster0.mongodb.net/?retryWrites=true', database: 'ventas' }),
      ).resolves.toEqual({ uri: 'mongodb+srv://u:p@cluster0.mongodb.net/?retryWrites=true', database: 'ventas' });
      await expect(validateCredentials('MONGODB', { uri: 'http://x', database: 'ventas' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('los metadatos muestran el host sin usuario ni contraseña', () => {
      const metadata = describeCredentials('MONGODB', {
        uri: 'mongodb://lector:S3creta@db1.internal:27017,db2.internal:27017/?replicaSet=rs0',
        database: 'ventas',
      });
      expect(metadata).toEqual({
        host: 'db1.internal:27017,db2.internal:27017',
        dbName: 'ventas',
        detalles: { srv: false },
      });
      expect(JSON.stringify(metadata)).not.toContain('S3creta');
    });
  });

  describe('FIRESTORE', () => {
    it('conserva solo los campos necesarios del Service Account', async () => {
      const credentials = await validateCredentials('FIRESTORE', { serviceAccount });
      expect(credentials).toEqual({
        databaseId: '(default)',
        serviceAccount: {
          type: 'service_account',
          project_id: 'datanexus-demo',
          private_key_id: 'abc123',
          private_key: PRIVATE_KEY,
          client_email: serviceAccount.client_email,
          client_id: '1234567890',
        },
      });
    });

    it('normaliza claves privadas con saltos de línea escapados', () => {
      const escaped = PRIVATE_KEY.replace(/\n/g, '\\n');
      expect(parseServiceAccount({ ...serviceAccount, private_key: escaped }).private_key).toBe(PRIVATE_KEY);
    });

    it.each([
      ['tipo distinto', { type: 'authorized_user' }, 'type'],
      ['sin project_id', { project_id: undefined }, 'project_id'],
      ['project_id inválido', { project_id: 'Mi Proyecto' }, 'project_id'],
      ['sin private_key', { private_key: undefined }, 'private_key'],
      ['private_key que no es PEM', { private_key: 'abc' }, 'private_key'],
      ['client_email inválido', { client_email: 'no-es-correo' }, 'client_email'],
    ])('rechaza un Service Account %s', (_label, override, field) => {
      const call = () => parseServiceAccount({ ...serviceAccount, ...override });
      expect(call).toThrow(BadRequestException);
      try {
        call();
      } catch (error) {
        expect(JSON.stringify((error as BadRequestException).getResponse())).toContain(field);
      }
    });

    it('lee el archivo subido y rechaza contenido que no es JSON', () => {
      expect(parseServiceAccountFile(Buffer.from(JSON.stringify(serviceAccount))).project_id).toBe('datanexus-demo');
      expect(() => parseServiceAccountFile(Buffer.from('not json'))).toThrow('El archivo no es un JSON válido');
      expect(() => parseServiceAccountFile(Buffer.from('[1,2]'))).toThrow(BadRequestException);
    });

    it('valida databaseId', async () => {
      await expect(validateCredentials('FIRESTORE', { serviceAccount, databaseId: 'Ventas DB' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('el driver recibe el JSON y los metadatos no incluyen la clave', async () => {
      const credentials = await validateCredentials('FIRESTORE', { serviceAccount, databaseId: 'ventas-db' });
      const driver = JSON.parse(toDriverConnectionString(serializeCredentials('FIRESTORE', credentials)));
      expect(driver).toMatchObject({ project_id: 'datanexus-demo', private_key: PRIVATE_KEY });
      const metadata = describeCredentials('FIRESTORE', credentials);
      expect(metadata).toMatchObject({ dbName: 'ventas-db', detalles: { projectId: 'datanexus-demo' } });
      expect(JSON.stringify(metadata)).not.toContain('PRIVATE KEY');
    });
  });

  describe('conversión al formato del driver', () => {
    it('PostgreSQL y MySQL codifican usuario y contraseña en la URL', async () => {
      const pg = await validateCredentials('POSTGRESQL', {
        host: 'db.internal',
        database: 'mi base',
        username: 'user@corp',
        password: 'p@ss:w/rd#?',
        ssl: true,
      });
      const url = new URL(toDriverConnectionString(serializeCredentials('POSTGRESQL', pg)));
      expect(url.protocol).toBe('postgresql:');
      expect(decodeURIComponent(url.username)).toBe('user@corp');
      expect(decodeURIComponent(url.password)).toBe('p@ss:w/rd#?');
      expect(decodeURIComponent(url.pathname)).toBe('/mi base');
      expect(url.searchParams.get('sslmode')).toBe('require');

      const mysql = await validateCredentials('MYSQL', {
        host: 'db.internal',
        database: 'a',
        username: 'u',
        password: 'p',
        ssl: true,
      });
      const mysqlUrl = new URL(toDriverConnectionString(serializeCredentials('MYSQL', mysql)));
      expect(mysqlUrl.protocol).toBe('mysql:');
      expect(mysqlUrl.port).toBe('3306');
      expect(mysqlUrl.searchParams.get('ssl')).toBe('true');
    });

    it('IPv6 va entre corchetes en la URL', async () => {
      const pg = await validateCredentials('POSTGRESQL', { host: '::1', database: 'a', username: 'u', password: 'p' });
      expect(toDriverConnectionString(serializeCredentials('POSTGRESQL', pg))).toContain('@[::1]:5432/');
    });

    it('las cadenas legado se devuelven sin cambios', () => {
      for (const legacy of ['postgres://u:p@h/db', 'Server=x;Password=y', JSON.stringify(serviceAccount)]) {
        expect(toDriverConnectionString(legacy)).toBe(legacy);
        expect(parseStoredCredentials(legacy)).toBeNull();
      }
    });
  });
});
