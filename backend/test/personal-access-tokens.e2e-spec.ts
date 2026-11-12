import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPersonalAccessToken } from '../src/auth/pat/personal-access-tokens.service.js';
import { bearer, createE2eApp, seedWorkspace, type E2eApp, type E2eWorkspace } from './e2e/helpers.js';

/** Tokens de acceso personal para integraciones (issue #65). */
describe('Tokens de acceso personal (e2e)', () => {
  let ctx: E2eApp;
  let ws: E2eWorkspace;
  let queryId: string;

  const pat = (token: string) => ({ Authorization: `Bearer ${token}` });
  const createToken = (user: { token: string }, body: Record<string, unknown>) =>
    ctx.http().post('/auth/tokens').set(bearer(user)).send(body);

  beforeAll(async () => {
    ctx = await createE2eApp();
    ws = await seedWorkspace(ctx, 'Pat');
    const connection = await ctx
      .http()
      .post('/connections')
      .set(bearer(ws.users.ADMIN))
      .send({ tipoMotor: 'POSTGRESQL', credenciales: { host: 'db.pat.internal', database: 'bi', username: 'bi', password: 'Clave#Pat2026' } })
      .expect(201);
    const query = await ctx
      .http()
      .post('/queries')
      .set(bearer(ws.users.ADMIN))
      .send({
        nombre: 'Para BI',
        visibilidad: 'PUBLICADA',
        definicion: {
          conexionSqlId: connection.body.id,
          conexionNoSqlId: connection.body.id,
          tablaSql: 'a',
          coleccionNoSql: 'b',
          llaveSql: 'id',
          llaveNoSql: 'id',
        },
      })
      .expect(201);
    queryId = query.body.id;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('crea un token, lo muestra una sola vez y solo guarda su hash', async () => {
    const created = await createToken(ws.users.OPERADOR, { nombre: 'Power BI', permisos: ['queries:read'], expiraEnDias: 30 }).expect(201);
    expect(created.body.token).toMatch(/^pat_[A-Za-z0-9_-]{43}$/);
    expect(created.body).toMatchObject({ nombre: 'Power BI', permisos: ['queries:read'], estado: 'ACTIVO', prefijo: created.body.token.slice(0, 12) });

    const stored = await ctx.prisma.personalAccessToken.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.tokenHash).toBe(hashPersonalAccessToken(created.body.token));
    expect(JSON.stringify(stored)).not.toContain(created.body.token);

    const listed = await ctx.http().get('/auth/tokens').set(bearer(ws.users.OPERADOR)).expect(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: created.body.id, estado: 'ACTIVO', lastUsedAt: null })]);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);
  });

  it('autentica integraciones con Bearer pat_… solo en los endpoints de su alcance', async () => {
    const { body } = await createToken(ws.users.OPERADOR, { nombre: 'Tablero', permisos: ['queries:read'] }).expect(201);

    await ctx.http().get('/queries').set(pat(body.token)).expect(200);
    await ctx.http().get(`/queries/${queryId}`).set(pat(body.token)).expect(200);
    // Fuera de su alcance, aunque el rol OPERADOR sí podría hacerlo.
    await ctx.http().get('/connections').set(pat(body.token)).expect(403);
    await ctx.http().post('/engine/join').set(pat(body.token)).send({}).expect(403);
    // Nunca sirve para endpoints de cuenta ni para gestionar tokens.
    await ctx.http().get('/auth/profile').set(pat(body.token)).expect(403);
    await ctx.http().post('/auth/tokens').set(pat(body.token)).send({ nombre: 'x', permisos: ['queries:read'] }).expect(403);

    const stored = await ctx.prisma.personalAccessToken.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.lastUsedAt).not.toBeNull();
  });

  it('un token nunca da más permisos que el rol de su dueño', async () => {
    // Al crearlo: el LECTOR no puede conceder exportaciones ni el AUDITOR consultas.
    await createToken(ws.users.LECTOR, { nombre: 'x', permisos: ['exports:create'] }).expect(400);
    await createToken(ws.users.AUDITOR, { nombre: 'x', permisos: ['queries:read'] }).expect(400);
    await createToken(ws.users.LECTOR, { nombre: 'x', permisos: ['admin:*'] }).expect(400);

    // Al usarlo: si el dueño pierde el rol, el token pierde el permiso al instante.
    const owner = ws.users.OPERADOR;
    const { body } = await createToken(owner, { nombre: 'Conexiones', permisos: ['connections:read'] }).expect(201);
    await ctx.http().get('/connections').set(pat(body.token)).expect(200);
    await ctx.prisma.user.update({ where: { id: owner.id }, data: { role: 'LECTOR' } });
    await ctx.http().get('/connections').set(pat(body.token)).expect(403);
    await ctx.prisma.user.update({ where: { id: owner.id }, data: { role: 'OPERADOR' } });
  });

  it('el catálogo de permisos indica cuáles puede conceder cada rol', async () => {
    const response = await ctx.http().get('/auth/tokens/scopes').set(bearer(ws.users.LECTOR)).expect(200);
    const available = (response.body as Array<{ permiso: string; disponible: boolean }>).filter((s) => s.disponible).map((s) => s.permiso);
    expect(available).toEqual(['queries:read']);
  });

  it('rotar invalida el token anterior y entrega uno nuevo con los mismos permisos', async () => {
    const { body: original } = await createToken(ws.users.ADMIN, { nombre: 'SIEM', permisos: ['audit:read'], expiraEnDias: 7 }).expect(201);
    const rotated = await ctx.http().post(`/auth/tokens/${original.id}/rotate`).set(bearer(ws.users.ADMIN)).expect(201);

    expect(rotated.body.token).not.toBe(original.token);
    expect(rotated.body).toMatchObject({ nombre: 'SIEM', permisos: ['audit:read'] });
    await ctx.http().get('/audit/logs').set(pat(original.token)).expect(401);
    await ctx.http().get('/audit/logs').set(pat(rotated.body.token)).expect(200);

    // No se puede rotar dos veces el mismo token.
    await ctx.http().post(`/auth/tokens/${original.id}/rotate`).set(bearer(ws.users.ADMIN)).expect(404);
  });

  it('un token revocado o caducado devuelve 401', async () => {
    const { body: revoked } = await createToken(ws.users.ADMIN, { nombre: 'Temporal', permisos: ['queries:read'] }).expect(201);
    await ctx.http().delete(`/auth/tokens/${revoked.id}`).set(bearer(ws.users.ADMIN)).expect(204);
    await ctx.http().get('/queries').set(pat(revoked.token)).expect(401);

    const { body: expired } = await createToken(ws.users.ADMIN, { nombre: 'Vencido', permisos: ['queries:read'] }).expect(201);
    await ctx.prisma.personalAccessToken.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await ctx.http().get('/queries').set(pat(expired.token)).expect(401);
    const listed = await ctx.http().get('/auth/tokens').set(bearer(ws.users.ADMIN)).expect(200);
    expect(listed.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: expired.id, estado: 'CADUCADO' })]));

    await ctx.http().get('/queries').set(pat('pat_inventado')).expect(401);
  });

  it('nadie puede ver, rotar ni revocar los tokens de otro usuario', async () => {
    const { body } = await createToken(ws.users.OPERADOR, { nombre: 'Privado', permisos: ['queries:read'] }).expect(201);
    const adminList = await ctx.http().get('/auth/tokens').set(bearer(ws.users.ADMIN)).expect(200);
    expect(JSON.stringify(adminList.body)).not.toContain(body.id);
    await ctx.http().post(`/auth/tokens/${body.id}/rotate`).set(bearer(ws.users.ADMIN)).expect(404);
    await ctx.http().delete(`/auth/tokens/${body.id}`).set(bearer(ws.users.ADMIN)).expect(404);
  });

  it('audita la creación, la rotación, el uso y la revocación', async () => {
    const events = await ctx.prisma.registroAuditoria.findMany({ where: { workspaceId: ws.id, targetType: 'PERSONAL_ACCESS_TOKEN' } });
    const types = new Set(events.map((event) => event.eventType));
    expect([...types].sort()).toEqual(['PAT_CREATED', 'PAT_REVOKED', 'PAT_ROTATED', 'PAT_USED']);
    expect(JSON.stringify(events)).not.toMatch(/pat_[A-Za-z0-9_-]{43}/);
  });
});
