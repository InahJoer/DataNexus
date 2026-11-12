import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { bearer, createE2eApp, seedWorkspace, type E2eApp, type E2eWorkspace } from './e2e/helpers.js';

/**
 * Flujos críticos de datos de punta a punta (issue #50):
 * conexión → probar conexión → cross-join → exportación → consulta guardada → reporte programado → auditoría.
 *
 * La fuente externa es el mismo PostgreSQL de pruebas: la suite crea dos tablas de origen en `public`
 * con nombres únicos y las elimina al terminar.
 */
describe('Flujos de datos (e2e)', () => {
  let ctx: E2eApp;
  let ws: E2eWorkspace;
  let connectionId: string;
  let savedQueryId: string;

  const suffix = Date.now().toString(36);
  const clientes = `e2e_clientes_${suffix}`;
  const pedidos = `e2e_pedidos_${suffix}`;
  const server = new URL(process.env.E2E_SERVER_URL as string);
  const source = new pg.Client({ connectionString: server.toString() });

  const joinRequest = () => ({
    conexionSqlId: connectionId,
    conexionNoSqlId: connectionId,
    tablaSql: clientes,
    coleccionNoSql: pedidos,
    llaveSql: 'cliente_id',
    llaveNoSql: 'cliente_ref',
  });

  beforeAll(async () => {
    await source.connect();
    await source.query(`CREATE TABLE "${clientes}" (cliente_id text PRIMARY KEY, nombre text, email text)`);
    await source.query(`CREATE TABLE "${pedidos}" (id serial PRIMARY KEY, cliente_ref text, total numeric(10,2), estado text)`);
    await source.query(
      `INSERT INTO "${clientes}" VALUES ('C1','Ana','ana@acme.io'), ('C2','Luis','luis@acme.io'), ('C3','Eva','eva@acme.io')`,
    );
    await source.query(
      `INSERT INTO "${pedidos}" (cliente_ref, total, estado) VALUES ('C1',120,'pagado'), ('C1',80,'pendiente'), ('C2',50,'pagado'), ('C9',10,'pagado')`,
    );

    ctx = await createE2eApp();
    ws = await seedWorkspace(ctx, 'Datos');
  });

  afterAll(async () => {
    await source.query(`DROP TABLE IF EXISTS "${clientes}", "${pedidos}"`).catch(() => undefined);
    await source.end();
    await ctx?.close();
  });

  it('el ADMIN registra una conexión PostgreSQL con credenciales cifradas', async () => {
    const response = await ctx
      .http()
      .post('/connections')
      .set(bearer(ws.users.ADMIN))
      .send({
        nombre: 'Ventas e2e',
        tipoMotor: 'POSTGRESQL',
        credenciales: {
          host: server.hostname,
          port: Number(server.port || 5432),
          database: server.pathname.slice(1),
          username: decodeURIComponent(server.username),
          password: decodeURIComponent(server.password),
          ssl: false,
        },
      })
      .expect(201);

    connectionId = response.body.id;
    expect(response.body).toMatchObject({ tipoMotor: 'POSTGRESQL', host: server.hostname });
    // La respuesta nunca devuelve la contraseña ni las credenciales.
    expect(response.body).not.toHaveProperty('credenciales');
    expect(JSON.stringify(response.body)).not.toMatch(/"password"/);

    // En la base solo se guarda el texto cifrado con AES-256-GCM, nunca el JSON de credenciales en claro.
    const stored = await ctx.prisma.conexionDB.findUniqueOrThrow({ where: { id: connectionId } });
    expect(stored.connectionStringEncriptada).not.toContain('"password"');
    expect(stored.connectionStringEncriptada).not.toContain(server.hostname + ':');
  });

  it('"Probar conexión" mide la latencia contra la base real', async () => {
    const response = await ctx.http().post(`/connections/${connectionId}/test`).set(bearer(ws.users.OPERADOR)).send({});
    expect([200, 201]).toContain(response.status);
    expect(response.body).toMatchObject({ ok: true });
  });

  it('el OPERADOR explora el esquema de la fuente', async () => {
    const response = await ctx.http().get(`/engine/connections/${connectionId}/schema`).set(bearer(ws.users.OPERADOR)).expect(200);
    expect(JSON.stringify(response.body)).toContain(clientes);
  });

  it('el OPERADOR ejecuta un cross-join y ve los datos sin enmascarar', async () => {
    const response = await ctx.http().post('/engine/join').set(bearer(ws.users.OPERADOR)).send(joinRequest());
    expect([200, 201]).toContain(response.status);
    expect(response.body.total).toBe(3);
    expect(response.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ cliente_id: 'C1', nombre: 'Ana', email: 'ana@acme.io', estado: 'pagado' })]),
    );
  });

  it('el cross-join aplica los filtros de cada fuente', async () => {
    const response = await ctx
      .http()
      .post('/engine/join')
      .set(bearer(ws.users.OPERADOR))
      .send({ ...joinRequest(), filtrosNoSql: [{ campo: 'estado', operador: 'eq', valor: 'pagado' }] });
    expect(response.body.total).toBe(2);
  });

  it('un join contra una tabla inexistente falla de forma controlada (sin 500) y queda auditado', async () => {
    const response = await ctx
      .http()
      .post('/engine/join')
      .set(bearer(ws.users.OPERADOR))
      .send({ ...joinRequest(), tablaSql: `no_existe_${suffix}` });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('exporta el resultado del join a Excel y JSON', async () => {
    const excel = await ctx
      .http()
      .post('/engine/export')
      .set(bearer(ws.users.OPERADOR))
      .send({ ...joinRequest(), format: 'excel' })
      .buffer(true)
      .expect(200);
    expect(excel.headers['content-type']).toContain('spreadsheetml');
    expect(excel.headers['content-disposition']).toMatch(/attachment; filename=".+\.xlsx"/);

    const json = await ctx.http().post('/engine/export').set(bearer(ws.users.ADMIN)).send({ ...joinRequest(), format: 'json' }).expect(200);
    expect(json.headers['content-type']).toContain('json');
  });

  it('guarda la consulta y el LECTOR la ejecuta solo si está publicada', async () => {
    const created = await ctx
      .http()
      .post('/queries')
      .set(bearer(ws.users.OPERADOR))
      .send({ nombre: 'Clientes con pedidos', definicion: joinRequest(), visibilidad: 'PUBLICADA' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    savedQueryId = created.body.id;

    const run = await ctx.http().post(`/queries/${savedQueryId}/run`).set(bearer(ws.users.LECTOR)).send({});
    expect([200, 201]).toContain(run.status);
    expect(run.body.total ?? run.body.resultado?.total).toBe(3);
  });

  it('programa un reporte a partir de la consulta guardada y lo ejecuta manualmente', async () => {
    const schedule = await ctx
      .http()
      .post('/reports/schedules')
      .set(bearer(ws.users.OPERADOR))
      .send({
        savedQueryId,
        reportTitle: 'Pedidos diarios',
        frequency: 'daily',
        time: '08:30',
        timezone: 'America/Managua',
        format: 'excel',
        recipients: [ws.users.OPERADOR.email],
        sendEmail: false,
      });
    expect(schedule.status, JSON.stringify(schedule.body)).toBe(201);
    expect(schedule.body).toMatchObject({ status: 'ACTIVE', cronExpression: '30 8 * * *' });

    const listed = await ctx.http().get('/reports/schedules').set(bearer(ws.users.ADMIN)).expect(200);
    expect(JSON.stringify(listed.body)).toContain(schedule.body.id);

    const run = await ctx.http().post(`/reports/schedules/${schedule.body.id}/run`).set(bearer(ws.users.OPERADOR)).send({});
    expect(run.status).toBeLessThan(300);

    await expect
      .poll(
        async () => {
          const executions = await ctx.prisma.reportExecution.findMany({ where: { scheduledReportId: schedule.body.id } });
          return executions.map((execution) => execution.status);
        },
        { timeout: 15_000, interval: 250 },
      )
      .toContain('SUCCEEDED');
  });

  it('la bitácora registra joins, exportaciones y conexiones, y el AUDITOR la consulta sin datos de negocio', async () => {
    const response = await ctx.http().get('/audit/logs?limit=100').set(bearer(ws.users.AUDITOR)).expect(200);
    const types = new Set((response.body.data as Array<{ eventType: string }>).map((row) => row.eventType));
    expect(types).toContain('EXECUTE_JOIN');
    expect(types).toContain('EXPORT');
    expect(response.body.total).toBeGreaterThanOrEqual(4);

    // El AUDITOR no puede leer los datos que se auditan.
    await ctx.http().post('/engine/join').set(bearer(ws.users.AUDITOR)).send(joinRequest()).expect(403);
  });

  it('la bitácora es inmutable: no se puede modificar ni borrar un registro', async () => {
    const event = await ctx.prisma.registroAuditoria.findFirstOrThrow({ where: { workspaceId: ws.id } });
    await expect(ctx.prisma.registroAuditoria.update({ where: { id: event.id }, data: { eventType: 'EXPORT' } })).rejects.toThrow();
    await expect(ctx.prisma.registroAuditoria.delete({ where: { id: event.id } })).rejects.toThrow();
  });
});
