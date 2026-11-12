import { Logger, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { isAllowedOrigin } from './config/cors-origins.js';
import { AllExceptionsFilter, logException, toApiErrorBody } from './observability/all-exceptions.filter.js';
import { requestIdMiddleware } from './observability/request-id.middleware.js';

/** Tamaño máximo por defecto del cuerpo JSON/formulario (issue #52). Los archivos van por multipart con su propio límite. */
export const DEFAULT_BODY_LIMIT = '1mb';

/** Origen rechazado por CORS: se responde 403 con el formato de error de la API, no un 500. */
class CorsRejectedError extends Error {
  readonly status = 403;
  readonly expose = true;
  constructor(origin: string | undefined) {
    super(`CORS bloqueado para el origen: ${origin ?? 'desconocido'}`);
  }
}

/** Valor de `trust proxy` de Express a partir de TRUST_PROXY (número de saltos, true o false). */
export function trustProxySetting(value: string | undefined): boolean | number {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return Number(value);
}

/**
 * Configuración HTTP común a main.ts y a las pruebas e2e (issues #51 y #52), para que las
 * pruebas ejerciten exactamente la misma cadena de middlewares que producción:
 * request id → cabeceras de seguridad → CORS → body parsers con límite → validación → errores uniformes.
 */
export function configureApp(app: NestExpressApplication, env: NodeJS.ProcessEnv = process.env): void {
  const isProduction = env.NODE_ENV === 'production';

  // Ejecuta OnModuleDestroy al recibir SIGTERM/SIGINT (Docker, Railway): cierra el pool de conexiones
  // externas y Prisma en lugar de dejar conexiones abiertas.
  app.enableShutdownHooks();

  app.set('trust proxy', trustProxySetting(env.TRUST_PROXY));
  app.disable('x-powered-by');

  app.use(requestIdMiddleware);

  // Cabeceras de seguridad (OWASP API8). La CSP permite los recursos propios de Swagger UI en /api/docs.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'https:'],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // CORS estricto (issue #6)
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    env.FRONTEND_URL,
    // URL pública de la propia API: permite usar Swagger UI (/api/docs) en producción
    env.API_PUBLIC_URL,
  ].filter((origin): origin is string => Boolean(origin));

  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Sin Origin (herramientas locales), dominios autorizados y, fuera de producción, la red local.
      if (isAllowedOrigin(origin, allowedOrigins, isProduction)) callback(null, true);
      else callback(new CorsRejectedError(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition', 'X-DataNexus-Truncated'],
  });

  // Límite del cuerpo (OWASP API4: consumo de recursos sin restricción).
  const limit = env.BODY_LIMIT ?? DEFAULT_BODY_LIMIT;
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', { limit, extended: true, parameterLimit: 1000 });

  // Errores anteriores a Nest (CORS, cuerpo demasiado grande, JSON mal formado) con el mismo formato que el resto.
  const httpLogger = new Logger('ExceptionFilter');
  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(error);
    const body = toApiErrorBody(error, request.path);
    logException(httpLogger, error, body, request.method);
    response.status(body.statusCode).json(body);
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}

/** Documentación OpenAPI en /api/docs. */
export function setupSwagger(app: NestExpressApplication): void {
  const config = new DocumentBuilder()
    .setTitle('DataNexus API')
    .setDescription('Plataforma Unificada de Gestión de Datos Mixtas y Business Intelligence')
    .setVersion('1.2.0')
    .addTag('Auth', 'Autenticación y generación de tokens JWT')
    .addTag('Connections', 'Gestión y administración de conexiones DB encriptadas con AES-256')
    .addTag('Users', 'Gestión de usuarios y roles dentro del workspace')
    .addTag('Workspaces', 'Gestión del espacio de trabajo: datos, configuración y estadísticas')
    .addTag('Engine - Cross-Join & Analytics', 'Motor de Cross-Joins en memoria, enmascaramiento y exportación')
    .addTag('Audit', 'Bitácora y consulta de logs de auditoría con paginación y filtros')
    .addTag('Reports - Automation', 'Automatización de reportes periódicos y despacho por correo electrónico')
    .addTag('Health', 'Sondas de disponibilidad para el monitoreo (liveness y readiness)')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
}
