import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createE2eApp, E2E_PASSWORD, login, seedWorkspace, type E2eApp } from './e2e/helpers.js';

/** Flujos críticos de autenticación y sesión (issue #50): registro, login, refresh, logout y errores. */
describe('Auth y sesión (e2e)', () => {
  let ctx: E2eApp;
  const email = `ana.${Date.now()}@gmail.com`;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('registro de cuenta personal: crea el workspace, deja al usuario como ADMIN y abre sesión', async () => {
    const response = await ctx
      .http()
      .post('/auth/signup')
      .send({ tipoCuenta: 'PERSONAL', name: 'Ana López', email, password: E2E_PASSWORD })
      .expect(201);

    expect(response.body.access_token).toEqual(expect.any(String));
    expect(response.body.refresh_token).toEqual(expect.any(String));
    expect(response.body.user).toMatchObject({ email, role: 'ADMIN' });
    expect(response.body.user).not.toHaveProperty('password');

    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { id: response.body.user.workspaceId } });
    expect(workspace.tipoCuenta).toBe('PERSONAL');
  });

  it('no permite registrar dos veces el mismo correo', async () => {
    await ctx
      .http()
      .post('/auth/signup')
      .send({ tipoCuenta: 'PERSONAL', name: 'Ana', email, password: E2E_PASSWORD })
      .expect(409);
  });

  it('valida el cuerpo y responde con el formato de error uniforme', async () => {
    const response = await ctx.http().post('/auth/login').send({ email: 'no-es-correo' }).expect(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      path: '/auth/login',
      requestId: response.headers['x-request-id'],
    });
    expect(Array.isArray(response.body.message)).toBe(true);
  });

  it('una contraseña incorrecta devuelve 401 sin revelar si el correo existe', async () => {
    const wrongPassword = await ctx.http().post('/auth/login').send({ email, password: 'Incorrecta#2026' }).expect(401);
    const unknownUser = await ctx
      .http()
      .post('/auth/login')
      .send({ email: `nadie.${Date.now()}@gmail.com`, password: 'Incorrecta#2026' })
      .expect(401);
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });

  it('login → perfil → refresh rotativo → logout', async () => {
    const session = await login(ctx, email);

    const profile = await ctx.http().get('/auth/profile').set('Authorization', `Bearer ${session.token}`).expect(200);
    expect(profile.body).toMatchObject({ email, role: 'ADMIN' });

    const refreshed = await ctx.http().post('/auth/refresh').send({ refresh_token: session.refreshToken });
    expect([200, 201]).toContain(refreshed.status);
    expect(refreshed.body.refresh_token).not.toBe(session.refreshToken);

    // El refresh token anterior queda invalidado tras la rotación.
    await ctx.http().post('/auth/refresh').send({ refresh_token: session.refreshToken }).expect(401);

    await ctx
      .http()
      .post('/auth/logout')
      .set('Authorization', `Bearer ${refreshed.body.access_token}`)
      .send({ refresh_token: refreshed.body.refresh_token })
      .expect(204);

    // Tras el logout, ni el refresh token ni el access token de esa sesión sirven.
    await ctx.http().post('/auth/refresh').send({ refresh_token: refreshed.body.refresh_token }).expect(401);
    await ctx.http().get('/auth/profile').set('Authorization', `Bearer ${refreshed.body.access_token}`).expect(401);
  });

  it('rechaza tokens ausentes, mal formados o firmados con otra clave', async () => {
    await ctx.http().get('/auth/profile').expect(401);
    await ctx.http().get('/auth/profile').set('Authorization', 'Bearer no-es-un-jwt').expect(401);
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      Buffer.from(JSON.stringify({ sub: 'x', role: 'ADMIN', sid: 'x', exp: 4102444800 })).toString('base64url') +
      '.firma-falsa';
    await ctx.http().get('/auth/profile').set('Authorization', `Bearer ${forged}`).expect(401);
  });

  it('bloquea la cuenta tras varios intentos fallidos aunque después llegue la contraseña correcta', async () => {
    const { users } = await seedWorkspace(ctx, 'Bloqueo');
    const target = users.LECTOR.email;
    for (let attempt = 0; attempt < 5; attempt++) {
      await ctx.http().post('/auth/login').send({ email: target, password: 'Incorrecta#2026' });
    }
    const response = await ctx.http().post('/auth/login').send({ email: target, password: E2E_PASSWORD });
    expect([401, 423, 429]).toContain(response.status);
  });
});
