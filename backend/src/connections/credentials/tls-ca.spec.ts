import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { describeCredentials, toDriverConnectionString, serializeCredentials, validateCredentials } from './connection-credentials.js';
import { CA_URL_PARAM, mysqlSslOption, postgresClientConfig } from './tls-ca.js';

// Certificado de ejemplo: solo importa el formato PEM, no se usa para conectar.
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIUQ2F0ZXN0Q0E=\nZGF0YW5leHVzLXRlc3QtY2E=\n-----END CERTIFICATE-----\n';
const base = { host: 'aws-0-us-east-2.pooler.supabase.com', port: 5432, database: 'postgres', username: 'postgres.ref', password: 'S3creta#2026' };

async function errorMessages(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const { message } = (error as BadRequestException).getResponse() as { message: string | string[] };
    return Array.isArray(message) ? message : [message];
  }
  throw new Error('Se esperaba un error de validación');
}

describe('Certificado CA propio (PostgreSQL / MySQL)', () => {
  it('acepta el PEM con ssl y lo normaliza', async () => {
    const credentials = await validateCredentials('POSTGRESQL', { ...base, ssl: true, caCertificate: `  ${CA_PEM.trim()}  ` });
    expect(credentials.caCertificate).toBe(CA_PEM);
  });

  it('acepta varios certificados encadenados y finales de línea de Windows', async () => {
    const chain = `${CA_PEM}${CA_PEM}`.replace(/\n/g, '\r\n');
    await expect(validateCredentials('MYSQL', { ...base, ssl: true, caCertificate: chain })).resolves.toMatchObject({ ssl: true });
  });

  it('un texto vacío equivale a no tener certificado (al editar, lo quita)', async () => {
    const credentials = await validateCredentials('POSTGRESQL', { ...base, ssl: true, caCertificate: '   ' });
    expect(credentials).not.toHaveProperty('caCertificate');
  });

  it('rechaza lo que no es un certificado PEM, incluidas claves privadas', async () => {
    expect(await errorMessages(validateCredentials('POSTGRESQL', { ...base, ssl: true, caCertificate: 'hola' }))).toEqual([
      'credenciales.caCertificate: El certificado CA debe estar en formato PEM (-----BEGIN CERTIFICATE-----)',
    ]);
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg==\n-----END PRIVATE KEY-----';
    expect(await errorMessages(validateCredentials('POSTGRESQL', { ...base, ssl: true, caCertificate: key }))).toHaveLength(1);
  });

  it('exige SSL para usar el certificado', async () => {
    expect(await errorMessages(validateCredentials('POSTGRESQL', { ...base, ssl: false, caCertificate: CA_PEM }))).toEqual([
      'credenciales.caCertificate: activa SSL/TLS para usar un certificado CA',
    ]);
  });

  it('los metadatos solo indican que hay certificado, sin su contenido', async () => {
    const credentials = await validateCredentials('POSTGRESQL', { ...base, ssl: true, caCertificate: CA_PEM });
    const { detalles } = describeCredentials('POSTGRESQL', credentials);
    expect(detalles).toMatchObject({ ssl: true, certificadoCa: true });
    expect(JSON.stringify(detalles)).not.toContain('BEGIN CERTIFICATE');
  });

  it('PostgreSQL: pasa la CA a node-postgres y quita sslmode para que no la reemplace', async () => {
    const credentials = await validateCredentials('POSTGRESQL', { ...base, ssl: true, caCertificate: CA_PEM });
    const url = new URL(toDriverConnectionString(serializeCredentials('POSTGRESQL', credentials)));
    expect(url.searchParams.get(CA_URL_PARAM)).toBeTruthy();

    const config = postgresClientConfig(url);
    expect(config.ssl).toEqual({ ca: CA_PEM, rejectUnauthorized: true });
    expect(config.connectionString).not.toContain('sslmode');
    expect(config.connectionString).not.toContain(CA_URL_PARAM);
  });

  it('PostgreSQL sin certificado conserva sslmode=require como hasta ahora', async () => {
    const credentials = await validateCredentials('POSTGRESQL', { ...base, ssl: true });
    const config = postgresClientConfig(new URL(toDriverConnectionString(serializeCredentials('POSTGRESQL', credentials))));
    expect(config.ssl).toBeUndefined();
    expect(config.connectionString).toContain('sslmode=require');
  });

  it('MySQL: usa la CA con verificación, {} con ssl sin CA y nada sin ssl', async () => {
    const withCa = await validateCredentials('MYSQL', { ...base, ssl: true, caCertificate: CA_PEM });
    expect(mysqlSslOption(new URL(toDriverConnectionString(serializeCredentials('MYSQL', withCa))))).toEqual({
      ca: CA_PEM,
      rejectUnauthorized: true,
    });
    const tlsOnly = await validateCredentials('MYSQL', { ...base, ssl: true });
    expect(mysqlSslOption(new URL(toDriverConnectionString(serializeCredentials('MYSQL', tlsOnly))))).toEqual({});
    const plain = await validateCredentials('MYSQL', { ...base, ssl: false });
    expect(mysqlSslOption(new URL(toDriverConnectionString(serializeCredentials('MYSQL', plain))))).toBeUndefined();
  });
});
