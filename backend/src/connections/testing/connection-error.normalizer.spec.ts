import { describe, expect, it } from 'vitest';
import { normalizeConnectionError } from './connection-error.normalizer.js';
import { InvalidConnectionConfigError } from './connection-tester.interface.js';

const err = (props: Record<string, unknown>, message = 'driver detail with SuperSecret') =>
  Object.assign(new Error(message), props);

describe('normalizeConnectionError', () => {
  it.each([
    // PostgreSQL (SQLSTATE)
    ['POSTGRESQL', err({ code: '28P01' }), 'AUTH_FAILED'],
    ['POSTGRESQL', err({ code: '3D000' }), 'DATABASE_NOT_FOUND'],
    ['POSTGRESQL', err({ code: '42501' }), 'PERMISSION_DENIED'],
    ['POSTGRESQL', err({}, 'no pg_hba.conf entry for host'), 'AUTH_FAILED'],
    ['POSTGRESQL', err({}, 'The server does not support SSL connections'), 'TLS_ERROR'],
    // MySQL
    ['MYSQL', err({ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 }), 'AUTH_FAILED'],
    ['MYSQL', err({ code: 'ER_BAD_DB_ERROR', errno: 1049 }), 'DATABASE_NOT_FOUND'],
    ['MYSQL', err({ code: 'ER_DBACCESS_DENIED_ERROR', errno: 1044 }), 'PERMISSION_DENIED'],
    ['MYSQL', err({ code: 'ER_HOST_NOT_PRIVILEGED', errno: 1130 }), 'PERMISSION_DENIED'],
    // SQL Server (mssql envuelve el error de tedious en originalError)
    ['SQLSERVER', err({ code: 'ELOGIN', originalError: err({ number: 18456 }) }), 'AUTH_FAILED'],
    ['SQLSERVER', err({ code: 'ELOGIN', originalError: err({ number: 4060 }) }), 'DATABASE_NOT_FOUND'],
    ['SQLSERVER', err({ code: 'ETIMEOUT' }), 'TIMEOUT'],
    ['SQLSERVER', err({ code: 'EINSTLOOKUP' }), 'HOST_NOT_FOUND'],
    ['SQLSERVER', err({ code: 'ESOCKET', originalError: err({ code: 'ECONNREFUSED' }) }), 'CONNECTION_REFUSED'],
    // Firestore (códigos gRPC)
    ['FIRESTORE', err({ code: 16 }), 'AUTH_FAILED'],
    ['FIRESTORE', err({ code: 7 }), 'PERMISSION_DENIED'],
    ['FIRESTORE', err({ code: 5 }), 'DATABASE_NOT_FOUND'],
    ['FIRESTORE', err({ code: 4 }), 'TIMEOUT'],
    ['FIRESTORE', err({ code: 14 }), 'NETWORK_ERROR'],
    ['FIRESTORE', err({}, 'invalid_grant: Invalid JWT Signature.'), 'AUTH_FAILED'],
    ['FIRESTORE', err({}, 'error:1E08010C:DECODER routines::unsupported'), 'INVALID_CONFIGURATION'],
    // Red, comunes a todos los motores
    ['POSTGRESQL', err({ code: 'ENOTFOUND' }), 'HOST_NOT_FOUND'],
    ['MYSQL', err({ code: 'EAI_AGAIN' }), 'HOST_NOT_FOUND'],
    ['MYSQL', err({ code: 'ETIMEDOUT' }), 'TIMEOUT'],
    ['POSTGRESQL', err({ code: 'ECONNRESET' }), 'NETWORK_ERROR'],
    ['POSTGRESQL', err({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }), 'TLS_ERROR'],
    // Node 20+: ECONNREFUSED en varias direcciones llega como AggregateError
    ['POSTGRESQL', Object.assign(new AggregateError([err({ code: 'ECONNREFUSED' })]), { code: 'ECONNREFUSED' }), 'CONNECTION_REFUSED'],
    ['MYSQL', new InvalidConnectionConfigError('x'), 'INVALID_CONFIGURATION'],
    ['POSTGRESQL', new Error('algo inesperado'), 'UNKNOWN'],
  ])('%s %#: → %s', (motor, error, expected) => {
    const result = normalizeConnectionError(error, motor);
    expect(result.code).toBe(expected);
    expect(result.message.length).toBeGreaterThan(10);
  });

  it('nunca reutiliza el texto del driver', () => {
    const error = err(
      { code: '28P01' },
      'password authentication failed for user "admin" at postgres://admin:SuperSecret@db',
    );
    const result = normalizeConnectionError(error, 'POSTGRESQL');
    expect(JSON.stringify(result)).not.toMatch(/SuperSecret|admin|postgres:\/\//);
  });

  it('adapta el mensaje al motor', () => {
    expect(normalizeConnectionError(err({ code: 16 }), 'FIRESTORE').message).toContain('cuenta de servicio');
    expect(normalizeConnectionError(err({ code: '28P01' }), 'POSTGRESQL').message).toBe(
      'Usuario o contraseña incorrectos.',
    );
    expect(normalizeConnectionError(err({ code: 'ETIMEDOUT' }), 'MYSQL', 5000).message).toContain('5 segundos');
  });

  it('no se cuelga con errores que se referencian a sí mismos', () => {
    const loop: Record<string, unknown> = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    loop.cause = loop;
    expect(normalizeConnectionError(loop, 'MYSQL').code).toBe('CONNECTION_REFUSED');
  });
});
