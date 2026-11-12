import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, HttpException, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter, toApiErrorBody } from './all-exceptions.filter.js';
import { runWithRequestContext } from './request-context.js';

describe('toApiErrorBody', () => {
  it('conserva statusCode, message y error de las excepciones HTTP y añade path, timestamp y requestId', () => {
    const body = runWithRequestContext({ requestId: 'req-1' }, () =>
      toApiErrorBody(new NotFoundException('Conexión no encontrada'), '/connections/1'),
    );
    expect(body).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      message: 'Conexión no encontrada',
      path: '/connections/1',
      requestId: 'req-1',
    });
    expect(Date.parse(body.timestamp)).not.toBeNaN();
  });

  it('mantiene la lista de mensajes de validación y los campos extra de la excepción', () => {
    const validation = toApiErrorBody(new BadRequestException(['email debe ser un correo', 'password es requerido']), '/auth/login');
    expect(validation.message).toEqual(['email debe ser un correo', 'password es requerido']);

    const custom = toApiErrorBody(new ConflictException({ message: 'Duplicado', code: 'EMAIL_TAKEN' }), '/users');
    expect(custom).toMatchObject({ statusCode: 409, error: 'Conflict', message: 'Duplicado', code: 'EMAIL_TAKEN' });
  });

  it('acepta excepciones con respuesta de texto', () => {
    expect(toApiErrorBody(new HttpException('Demasiadas peticiones', 429), '/x')).toMatchObject({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Demasiadas peticiones',
    });
  });

  it('traduce los errores 4xx de body-parser sin exponer detalles cuando expose es false', () => {
    expect(toApiErrorBody(Object.assign(new Error('request entity too large'), { status: 413, expose: true }), '/x')).toMatchObject({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'request entity too large',
    });
    expect(toApiErrorBody(Object.assign(new Error('detalle interno'), { status: 400, expose: false }), '/x').message).toBe('Bad Request');
  });

  it('oculta el detalle de los errores inesperados detrás de un 500 genérico', () => {
    const body = toApiErrorBody(new Error('relation "secret_table" does not exist'), '/engine/join');
    expect(body).toMatchObject({ statusCode: 500, error: 'Internal Server Error', message: 'Error interno del servidor' });
    expect(JSON.stringify(body)).not.toContain('secret_table');
  });
});

describe('AllExceptionsFilter', () => {
  const hostFor = (response: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; headersSent?: boolean }) =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ path: '/reports', url: '/reports?token=x', method: 'GET' }),
        getResponse: () => response,
      }),
    }) as unknown as ArgumentsHost;

  it('responde con el código y el cuerpo uniforme', () => {
    const json = vi.fn();
    const response = { status: vi.fn(() => ({ json })), json: vi.fn() };
    new AllExceptionsFilter().catch(new NotFoundException('No existe'), hostFor(response));
    expect(response.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, path: '/reports', message: 'No existe' }));
  });

  it('no intenta responder si las cabeceras ya se enviaron (descargas en streaming)', () => {
    const response = { status: vi.fn(), json: vi.fn(), headersSent: true };
    new AllExceptionsFilter().catch(new Error('stream roto'), hostFor(response));
    expect(response.status).not.toHaveBeenCalled();
  });
});
