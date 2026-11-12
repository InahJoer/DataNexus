import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppLogger, createAppLogger, logLevelsFrom } from './app-logger.js';
import { currentRequestId, resolveRequestId, runWithRequestContext } from './request-context.js';
import { requestIdMiddleware } from './request-id.middleware.js';

describe('resolveRequestId', () => {
  it('reutiliza un X-Request-Id entrante válido', () => {
    expect(resolveRequestId('railway-abc_123:9')).toBe('railway-abc_123:9');
    expect(resolveRequestId(['primero', 'segundo'])).toBe('primero');
  });

  it('genera un UUID si falta o trae caracteres peligrosos para los logs', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(resolveRequestId(undefined)).toMatch(uuid);
    expect(resolveRequestId('id con espacios\n{"level":"fatal"}')).toMatch(uuid);
    expect(resolveRequestId('x'.repeat(200))).toMatch(uuid);
  });
});

describe('requestIdMiddleware', () => {
  afterEach(() => vi.restoreAllMocks());

  const fakeResponse = (statusCode: number) => Object.assign(new EventEmitter(), { statusCode, setHeader: vi.fn() });

  it('devuelve la cabecera X-Request-Id y propaga el id a todo el manejo de la petición', () => {
    const response = fakeResponse(200);
    let seen: string | undefined;
    const next: NextFunction = () => {
      seen = currentRequestId();
    };
    requestIdMiddleware({ headers: { 'x-request-id': 'abc-123' }, method: 'GET', path: '/health' } as unknown as Request, response as unknown as Response, next);
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'abc-123');
    expect(seen).toBe('abc-123');
    expect(currentRequestId()).toBeUndefined();
  });

  it('registra la línea de acceso sin la query string y con el nivel según el código', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const response = fakeResponse(404);
    requestIdMiddleware(
      { headers: {}, method: 'GET', path: '/reports/download', url: '/reports/download?token=secreto' } as unknown as Request,
      response as unknown as Response,
      () => undefined,
    );
    response.emit('finish');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^GET \/reports\/download 404 \d+ms$/), expect.objectContaining({ status: 404 }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secreto');
  });
});

describe('AppLogger', () => {
  it('logLevelsFrom incluye el nivel pedido y los más graves', () => {
    expect(logLevelsFrom('warn')).toEqual(['fatal', 'error', 'warn']);
    expect(logLevelsFrom(undefined)).toEqual(['fatal', 'error', 'warn', 'log']);
    expect(logLevelsFrom('desconocido')).toEqual(['fatal', 'error', 'warn', 'log']);
  });

  it('usa JSON en producción o con LOG_FORMAT=json y texto en el resto', () => {
    const isJson = (logger: AppLogger) => (logger as unknown as { options: { json?: boolean } }).options.json;
    expect(isJson(createAppLogger({ NODE_ENV: 'production' }))).toBe(true);
    expect(isJson(createAppLogger({ NODE_ENV: 'development' }))).toBe(false);
    expect(isJson(createAppLogger({ NODE_ENV: 'development', LOG_FORMAT: 'json' }))).toBe(true);
  });

  it('en JSON añade el requestId de la petición en curso y oculta secretos', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = createAppLogger({ NODE_ENV: 'production' });
    runWithRequestContext({ requestId: 'req-42' }, () => logger.log('Conexión creada', { usuario: 'ana', password: 'Secreta#1' }, 'Connections'));
    const line = JSON.parse(String(write.mock.calls.at(-1)?.[0]));
    write.mockRestore();
    expect(line).toMatchObject({ level: 'log', message: 'Conexión creada', context: 'Connections', requestId: 'req-42', usuario: 'ana' });
    expect(line.password).toBe('[REDACTED]');
  });
});
