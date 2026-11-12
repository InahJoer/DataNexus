import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createE2eApp, seedWorkspace, type E2eApp, type E2eWorkspace } from './e2e/helpers.js';

/**
 * Aislamiento multi-tenant (issue #50, criterio de RF-05): un usuario nunca ve ni modifica
 * datos de otro workspace, aunque conozca sus identificadores y tenga rol ADMIN en el suyo.
 */
describe('Aislamiento entre workspaces (e2e)', () => {
  let ctx: E2eApp;
  let a: E2eWorkspace;
  let b: E2eWorkspace;
  let connectionA: string;
  let queryA: string;

  beforeAll(async () => {
    ctx = await createE2eApp();
    [a, b] = [await seedWorkspace(ctx, 'Alfa'), await seedWorkspace(ctx, 'Beta')];

    const connection = await ctx
      .http()
      .post('/connections')
      .set(bearer(a.users.ADMIN))
      .send({
        nombre: 'Privada de Alfa',
        tipoMotor: 'POSTGRESQL',
        credenciales: { host: 'db.alfa.internal', database: 'ventas', username: 'bi', password: 'Clave#Alfa2026' },
      })
      .expect(201);
    connectionA = connection.body.id;

    const query = await ctx
      .http()
      .post('/queries')
      .set(bearer(a.users.OPERADOR))
      .send({
        nombre: 'Consulta de Alfa',
        visibilidad: 'PUBLICADA',
        definicion: {
          conexionSqlId: connectionA,
          conexionNoSqlId: connectionA,
          tablaSql: 'clientes',
          coleccionNoSql: 'pedidos',
          llaveSql: 'id',
          llaveNoSql: 'cliente_id',
        },
      })
      .expect(201);
    queryA = query.body.id;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('los listados de B no incluyen recursos de A', async () => {
    const connections = await ctx.http().get('/connections').set(bearer(b.users.ADMIN)).expect(200);
    expect(JSON.stringify(connections.body)).not.toContain(connectionA);

    const queries = await ctx.http().get('/queries').set(bearer(b.users.ADMIN)).expect(200);
    expect(JSON.stringify(queries.body)).not.toContain(queryA);

    const members = await ctx.http().get('/users').set(bearer(b.users.ADMIN)).expect(200);
    expect(JSON.stringify(members.body)).not.toContain(a.users.ADMIN.email);
  });

  it('B no puede leer, modificar ni borrar una conexión de A conociendo su id', async () => {
    await ctx.http().get(`/connections/${connectionA}`).set(bearer(b.users.ADMIN)).expect(404);
    await ctx.http().patch(`/connections/${connectionA}`).set(bearer(b.users.ADMIN)).send({ nombre: 'Robada' }).expect(404);
    await ctx.http().delete(`/connections/${connectionA}`).set(bearer(b.users.ADMIN)).expect(404);

    const stored = await ctx.prisma.conexionDB.findUniqueOrThrow({ where: { id: connectionA } });
    expect(stored.nombre).toBe('Privada de Alfa');
  });

  it('B no puede usar la conexión de A en joins, exploración ni pruebas', async () => {
    const join = await ctx
      .http()
      .post('/engine/join')
      .set(bearer(b.users.OPERADOR))
      .send({
        conexionSqlId: connectionA,
        conexionNoSqlId: connectionA,
        tablaSql: 'clientes',
        coleccionNoSql: 'pedidos',
        llaveSql: 'id',
        llaveNoSql: 'cliente_id',
      });
    expect(join.status).toBe(404);
    await ctx.http().get(`/engine/connections/${connectionA}/schema`).set(bearer(b.users.OPERADOR)).expect(404);
    await ctx.http().post(`/connections/${connectionA}/test`).set(bearer(b.users.OPERADOR)).send({}).expect(404);
  });

  it('B no puede leer ni ejecutar las consultas guardadas de A', async () => {
    await ctx.http().get(`/queries/${queryA}`).set(bearer(b.users.ADMIN)).expect(404);
    await ctx.http().post(`/queries/${queryA}/run`).set(bearer(b.users.LECTOR)).send({}).expect(404);
    await ctx.http().delete(`/queries/${queryA}`).set(bearer(b.users.ADMIN)).expect(404);
  });

  it('B no puede gestionar miembros de A', async () => {
    await ctx.http().patch(`/users/${a.users.LECTOR.id}/role`).set(bearer(b.users.ADMIN)).send({ role: 'ADMIN' }).expect(404);
    await ctx.http().delete(`/users/${a.users.LECTOR.id}`).set(bearer(b.users.ADMIN)).expect(404);
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.users.LECTOR.id } });
    expect(stored.role).toBe('LECTOR');
  });

  it('la bitácora de B no contiene eventos de A', async () => {
    const logsB = await ctx.http().get('/audit/logs?limit=100').set(bearer(b.users.AUDITOR)).expect(200);
    const rows = logsB.body.data as Array<{ workspaceId: string; actorEmail: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.workspaceId).toBe(b.id);
      expect(row.actorEmail ?? '').not.toContain(a.users.ADMIN.email.split('@')[1]);
    }
    // Los intentos fallidos de B contra recursos de A sí quedan en la bitácora de B (es lo que debe auditarse).
    expect(rows.some((row) => (row as { eventType?: string; outcome?: string }).outcome === 'FAILURE')).toBe(true);

    const eventA = await ctx.prisma.registroAuditoria.findFirstOrThrow({ where: { workspaceId: a.id } });
    await ctx.http().get(`/audit/logs/${eventA.id}`).set(bearer(b.users.AUDITOR)).expect(404);
  });

  it('/workspaces/me devuelve siempre el workspace del token', async () => {
    const meA = await ctx.http().get('/workspaces/me').set(bearer(a.users.LECTOR)).expect(200);
    const meB = await ctx.http().get('/workspaces/me').set(bearer(b.users.LECTOR)).expect(200);
    expect(meA.body.id).toBe(a.id);
    expect(meB.body.id).toBe(b.id);
  });
});
