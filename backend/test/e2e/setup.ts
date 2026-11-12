/**
 * Base de datos aislada por suite e2e (issue #50).
 *
 * Vitest ejecuta este archivo antes de cada *.e2e-spec.ts: crea un esquema de PostgreSQL propio
 * (`e2e_<aleatorio>`), le aplica las migraciones con Prisma y apunta DATABASE_URL a él antes de que
 * la suite importe AppModule. Al terminar la suite el esquema se elimina. Así las suites pueden
 * correr en paralelo sin compartir datos y sin tocar el esquema `public` de desarrollo.
 *
 * Requiere E2E_DATABASE_URL o DATABASE_URL apuntando a un PostgreSQL donde el usuario pueda crear esquemas.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll } from 'vitest';

const baseUrl = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
if (!baseUrl) {
  throw new Error(
    'Las pruebas e2e necesitan PostgreSQL: define E2E_DATABASE_URL o DATABASE_URL ' +
      '(por ejemplo postgresql://datanexus:datanexus@localhost:5432/datanexus).',
  );
}

export const E2E_SCHEMA = `e2e_${randomBytes(5).toString('hex')}`;

const serverUrl = new URL(baseUrl);
serverUrl.search = '';
const schemaUrl = new URL(serverUrl);
schemaUrl.searchParams.set('schema', E2E_SCHEMA);

/** URL del servidor sin esquema: las suites la usan para crear tablas de origen de datos. */
process.env.E2E_SERVER_URL = serverUrl.toString();
process.env.DATABASE_URL = schemaUrl.toString();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'e2e-only-jwt-secret-0123456789abcdefghijklmnop';
process.env.ENCRYPTION_KEY ??= 'b'.repeat(64);
// Cada suite hace cientos de peticiones desde la misma IP; el límite real se prueba aparte.
process.env.RATE_LIMIT_PER_MINUTE = '10000';
// Los correos (invitaciones, reportes) usan el transporter simulado.
process.env.SMTP_HOST = '';
delete process.env.REDIS_URL;

const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  stdio: 'pipe',
});

afterAll(async () => {
  const client = new pg.Client({ connectionString: serverUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${E2E_SCHEMA}" CASCADE`);
  } finally {
    await client.end();
  }
});
