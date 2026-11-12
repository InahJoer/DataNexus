import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createE2eApp, type E2eApp } from './e2e/helpers.js';

/** Observabilidad (#51) y hardening HTTP (#52) sobre la API real. */
describe('Plataforma: health, request id y cabeceras de seguridad (e2e)', () => {
  let ctx: E2eApp;

  beforeAll(async () => {
    ctx = await createE2eApp({ ...process.env, BODY_LIMIT: '10kb' });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('GET /health responde sin autenticación y sin consultar dependencias', async () => {
    const response = await ctx.http().get('/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', uptimeSeconds: expect.any(Number) });
  });

  it('GET /health/ready comprueba PostgreSQL, Redis y SMTP', async () => {
    const response = await ctx.http().get('/health/ready').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.details).toMatchObject({
      database: { status: 'up' },
      redis: { status: 'up', mode: 'memory' },
      smtp: { status: 'up', mode: 'simulated' },
    });
  });

  it('asigna un X-Request-Id a cada respuesta y respeta el que envía el cliente', async () => {
    const generated = await ctx.http().get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const propagated = await ctx.http().get('/connections').set('X-Request-Id', 'trace-e2e-001').expect(401);
    expect(propagated.headers['x-request-id']).toBe('trace-e2e-001');
    expect(propagated.body.requestId).toBe('trace-e2e-001');
  });

  it('envía las cabeceras de seguridad de helmet y oculta X-Powered-By', async () => {
    const response = await ctx.http().get('/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('rechaza con 413 un cuerpo mayor que BODY_LIMIT, con el formato de error de la API', async () => {
    const response = await ctx
      .http()
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.io', password: 'x'.repeat(20_000) }))
      .expect(413);
    expect(response.body).toMatchObject({ statusCode: 413, path: '/auth/login', requestId: expect.any(String) });
  });

  it('un JSON mal formado devuelve 400, no 500', async () => {
    const response = await ctx.http().post('/auth/login').set('Content-Type', 'application/json').send('{"email":').expect(400);
    expect(response.body.statusCode).toBe(400);
  });

  it('CORS: rechaza orígenes no autorizados con 403 y acepta el frontend configurado', async () => {
    await ctx.http().get('/health').set('Origin', 'https://atacante.example').expect(403);
    const allowed = await ctx.http().get('/health').set('Origin', 'http://localhost:3000').expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-expose-headers']).toContain('X-Request-Id');
  });

  it('una ruta inexistente devuelve 404 con el formato uniforme', async () => {
    const response = await ctx.http().get('/no-existe').expect(404);
    expect(response.body).toMatchObject({ statusCode: 404, error: 'Not Found', path: '/no-existe' });
  });
});
