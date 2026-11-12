import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { assertTlsPolicy, externalTlsRequired, mongoUriUsesTls } from './tls-policy.js';

const sql = { host: 'db.acme.io', port: 5432, database: 'ventas', username: 'bi', password: 'x' };

describe('externalTlsRequired', () => {
  it('se exige por defecto solo en producción', () => {
    expect(externalTlsRequired({ NODE_ENV: 'production' })).toBe(true);
    expect(externalTlsRequired({ NODE_ENV: 'development' })).toBe(false);
  });

  it('EXTERNAL_DB_REQUIRE_TLS fuerza el valor en cualquier entorno', () => {
    expect(externalTlsRequired({ NODE_ENV: 'production', EXTERNAL_DB_REQUIRE_TLS: 'false' })).toBe(false);
    expect(externalTlsRequired({ NODE_ENV: 'test', EXTERNAL_DB_REQUIRE_TLS: 'true' })).toBe(true);
  });
});

describe('mongoUriUsesTls', () => {
  it('mongodb+srv usa TLS salvo que se desactive', () => {
    expect(mongoUriUsesTls('mongodb+srv://u:p@cluster0.mongodb.net/app')).toBe(true);
    expect(mongoUriUsesTls('mongodb+srv://u:p@cluster0.mongodb.net/app?tls=false')).toBe(false);
  });

  it('mongodb:// solo usa TLS con tls=true o ssl=true', () => {
    expect(mongoUriUsesTls('mongodb://localhost:27017/app')).toBe(false);
    expect(mongoUriUsesTls('mongodb://localhost:27017/app?tls=true')).toBe(true);
    expect(mongoUriUsesTls('mongodb://localhost:27017/app?retryWrites=true&ssl=TRUE')).toBe(true);
  });
});

describe('assertTlsPolicy', () => {
  const rejects = (fn: () => void) => expect(fn).toThrow(BadRequestException);

  it('no comprueba nada si la política está desactivada', () => {
    expect(() => assertTlsPolicy('POSTGRESQL', { ...sql, ssl: false }, false)).not.toThrow();
  });

  it('exige ssl en PostgreSQL y MySQL', () => {
    rejects(() => assertTlsPolicy('POSTGRESQL', { ...sql, ssl: false }, true));
    rejects(() => assertTlsPolicy('MYSQL', { ...sql, ssl: false }, true));
    expect(() => assertTlsPolicy('MYSQL', { ...sql, ssl: true }, true)).not.toThrow();
  });

  it('exige encrypt y validación del certificado en SQL Server', () => {
    rejects(() => assertTlsPolicy('SQLSERVER', { ...sql, encrypt: false, trustServerCertificate: false }, true));
    rejects(() => assertTlsPolicy('SQLSERVER', { ...sql, encrypt: true, trustServerCertificate: true }, true));
    expect(() => assertTlsPolicy('SQLSERVER', { ...sql, encrypt: true, trustServerCertificate: false }, true)).not.toThrow();
  });

  it('exige TLS en MongoDB y nunca bloquea Firestore', () => {
    rejects(() => assertTlsPolicy('MONGODB', { uri: 'mongodb://10.0.0.5/app', database: 'app' }, true));
    expect(() => assertTlsPolicy('MONGODB', { uri: 'mongodb+srv://c.mongodb.net/app', database: 'app' }, true)).not.toThrow();
    expect(() => assertTlsPolicy('FIRESTORE', {}, true)).not.toThrow();
  });

  it('el mensaje indica el campo a corregir', () => {
    try {
      assertTlsPolicy('POSTGRESQL', { ...sql, ssl: false }, true);
      expect.unreachable();
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({ message: [expect.stringMatching(/^credenciales\.ssl:/)] });
    }
  });
});
