import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER, resolveRequestId, runWithRequestContext } from './request-context.js';

const logger = new Logger('HTTP');

/**
 * Asigna un request id a cada petición, lo devuelve en la cabecera `X-Request-Id`
 * y registra una línea de acceso al terminar (issue #51).
 *
 * Se registra solo la ruta, nunca la query string: los enlaces de descarga y de
 * recuperación pueden llevar tokens en ella.
 */
export function requestIdMiddleware(request: Request, response: Response, next: NextFunction): void {
  const requestId = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
  const startedAt = performance.now();
  response.setHeader('X-Request-Id', requestId);

  runWithRequestContext({ requestId }, () => {
    response.on('finish', () => {
      const status = response.statusCode;
      const entry = {
        method: request.method,
        path: request.path,
        status,
        durationMs: Math.round(performance.now() - startedAt),
      };
      const message = `${entry.method} ${entry.path} ${status} ${entry.durationMs}ms`;
      if (status >= 500) logger.error(message, entry);
      else if (status >= 400) logger.warn(message, entry);
      else logger.log(message, entry);
    });
    next();
  });
}
