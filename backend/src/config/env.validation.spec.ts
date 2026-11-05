import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation.js';

const VALID = {
  DATABASE_URL: 'postgresql://datanexus:datanexus@localhost:5432/datanexus',
  JWT_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: 'a1'.repeat(32),
};

describe('validateEnv', () => {
  it('acepta una configuración mínima válida y convierte números', () => {
    const env = validateEnv({ ...VALID, PORT: '3001', SMTP_PORT: '587' });
    expect(env.PORT).toBe(3001);
    expect(env.SMTP_PORT).toBe(587);
    expect(env.NODE_ENV).toBe('development');
  });

  it('trata las variables vacías como no definidas', () => {
    expect(() => validateEnv({ ...VALID, SMTP_HOST: '', SMTP_PORT: '', FRONTEND_URL: '' })).not.toThrow();
  });

  it('conserva variables no declaradas', () => {
    const env = validateEnv({ ...VALID, OTRA_VARIABLE: 'ok' }) as unknown as Record<string, unknown>;
    expect(env.OTRA_VARIABLE).toBe('ok');
  });

  it('falla si faltan las variables críticas y lista todos los problemas', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET[\s\S]*ENCRYPTION_KEY/);
  });

  it('rechaza DATABASE_URL que no sea PostgreSQL (p. ej. el SQLite anterior)', () => {
    expect(() => validateEnv({ ...VALID, DATABASE_URL: 'file:./dev.db' })).toThrow(/DATABASE_URL/);
  });

  it('rechaza JWT_SECRET corto y ENCRYPTION_KEY que no sea hex de 64', () => {
    expect(() => validateEnv({ ...VALID, JWT_SECRET: 'corto' })).toThrow(/JWT_SECRET/);
    expect(() => validateEnv({ ...VALID, ENCRYPTION_KEY: 'no-es-hex' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('en producción rechaza los valores de ejemplo de .env.example', () => {
    expect(() =>
      validateEnv({
        ...VALID,
        NODE_ENV: 'production',
        JWT_SECRET: 'cambia-esto-por-un-secreto-largo-y-aleatorio-de-64-caracteres',
        ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    ).toThrow(/JWT_SECRET[\s\S]*ENCRYPTION_KEY/);
  });

  it('en desarrollo permite los valores de ejemplo', () => {
    expect(() =>
      validateEnv({
        ...VALID,
        JWT_SECRET: 'cambia-esto-por-un-secreto-largo-y-aleatorio-de-64-caracteres',
        ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    ).not.toThrow();
  });
});
