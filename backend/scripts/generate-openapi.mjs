/**
 * Regenera docs/openapi/v1.yaml (y v1.json) a partir de los decoradores de la API (issue #53).
 * Uso: npm run openapi:generate   (compila antes con `nest build`)
 *
 * Arranca Nest en modo preview: no instancia proveedores ni abre conexiones a la base de datos.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { dump } from 'js-yaml';

process.env.NODE_ENV ??= 'development';
process.env.DATABASE_URL ??= 'postgresql://openapi:openapi@localhost:5432/openapi';
process.env.JWT_SECRET ??= 'openapi-generation-only-secret-0123456789';
process.env.ENCRYPTION_KEY ??= 'c'.repeat(64);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { AppModule } = await import(pathToFileURL(join(root, 'dist/app.module.js')).href);
const { buildOpenApiDocument } = await import(pathToFileURL(join(root, 'dist/app.setup.js')).href);

const app = await NestFactory.create(AppModule, { preview: true, logger: false, abortOnError: false });
const document = buildOpenApiDocument(app);
await app.close();

const output = join(root, 'docs/openapi');
mkdirSync(output, { recursive: true });
const header = '# Generado con `npm run openapi:generate` a partir del código. No editar a mano.\n';
writeFileSync(join(output, 'v1.yaml'), header + dump(document, { noRefs: true, lineWidth: 120 }));
writeFileSync(join(output, 'v1.json'), `${JSON.stringify(document, null, 2)}\n`);
console.log(`OpenAPI ${document.openapi} · ${Object.keys(document.paths).length} rutas → docs/openapi/v1.yaml`);
process.exit(0);
