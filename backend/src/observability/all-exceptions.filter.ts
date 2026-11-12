import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { currentRequestId } from './request-context.js';

/**
 * Formato uniforme de error de la API (issue #51).
 * Conserva los campos que Nest ya devolvía (`statusCode`, `message`, `error` y cualquier
 * campo extra de la excepción) para no romper al frontend, y añade `path`, `timestamp`
 * y `requestId` para poder buscar el error en los logs.
 */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId?: string;
  [extra: string]: unknown;
}

const INTERNAL_ERROR_MESSAGE = 'Error interno del servidor';

function reasonPhrase(status: number): string {
  const name = HttpStatus[status];
  if (typeof name !== 'string') return 'Error';
  return name
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Construye el cuerpo de error a partir de cualquier excepción (también fuera de Nest: body-parser, CORS). */
export function toApiErrorBody(exception: unknown, path: string): ApiErrorBody {
  const base = { path, timestamp: new Date().toISOString(), requestId: currentRequestId() };

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const details = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
    const message =
      typeof response === 'string'
        ? response
        : ((details.message as string | string[] | undefined) ?? exception.message);
    return {
      ...details,
      statusCode: status,
      error: typeof details.error === 'string' ? details.error : reasonPhrase(status),
      message,
      ...base,
    };
  }

  // Errores de body-parser (cuerpo demasiado grande o JSON inválido) llegan con `status`/`statusCode`.
  const httpLike = exception as { status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
  const status = Number(httpLike?.status ?? httpLike?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return {
      statusCode: status,
      error: reasonPhrase(status),
      message: httpLike.expose === true && typeof httpLike.message === 'string' ? httpLike.message : reasonPhrase(status),
      ...base,
    };
  }

  // Nunca se exponen detalles internos (consultas, rutas, stack) al cliente.
  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    error: reasonPhrase(HttpStatus.INTERNAL_SERVER_ERROR),
    message: INTERNAL_ERROR_MESSAGE,
    ...base,
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const body = toApiErrorBody(exception, request.path ?? request.url);
    logException(this.logger, exception, body, request.method);
    if (response.headersSent) return;
    response.status(body.statusCode).json(body);
  }
}

/** Los 5xx se registran con su stack. Los 4xx ya quedan en la línea de acceso del middleware (nivel warn). */
export function logException(logger: Logger, exception: unknown, body: ApiErrorBody, method: string): void {
  if (body.statusCode >= 500) {
    logger.error(
      `${method} ${body.path} -> ${body.statusCode}: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
  }
}
