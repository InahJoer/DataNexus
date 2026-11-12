import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { bearer, createE2eApp, seedWorkspace, type E2eApp, type E2eWorkspace } from './e2e/helpers.js';

/**
 * Carga masiva de Excel de punta a punta: la subida responde de inmediato (PROCESANDO), la hoja se guarda en su
 * propia tabla, se explora por páginas, se cruza con PostgreSQL solo por las llaves que coinciden (semi-join, aunque
 * la hoja supere el máximo por fuente), se reemplaza conservando el id y se elimina junto con sus tablas.
 */
describe('Archivos de Excel masivos (e2e)', () => {
  let ctx: E2eApp;
  let ws: E2eWorkspace;
  let excelId: string;
  const ROWS = 30_000;
  const clientes = `e2e_xl_clientes_${Date.now().toString(36)}`;
  const server = new URL(process.env.E2E_SERVER_URL as string);
  const source = new pg.Client({ connectionString: server.toString() });

  const csv = (rows: number) => {
    const lines = ['id;nombre;zona;monto'];
    for (let i = 1; i <= rows; i += 1) lines.push(`${i};Cliente ${i};${i % 2 ? 'Norte' : 'Sur'};${i * 1.5}`);
    return Buffer.from(lines.join('\r\n'), 'utf8');
  };

  const waitReady = async (id: string) => {
    let body: Record<string, any> = {};
    await expect
      .poll(
        async () => {
          body = (await ctx.http().get(`/excel/${id}`).set(bearer(ws.users.ADMIN)).expect(200)).body;
          return body.estado;
        },
        { timeout: 60_000, interval: 200 },
      )
      .not.toBe('PROCESANDO');
    return body;
  };

  const excelTables = async () =>
    (
      await ctx.prisma.$queryRaw<Array<{ name: string }>>`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'xl\\_%'`
    ).map((row) => row.name);

  beforeAll(async () => {
    await source.connect();
    await source.query(`CREATE TABLE "${clientes}" (id integer PRIMARY KEY, segmento text)`);
    await source.query(`INSERT INTO "${clientes}" VALUES (5, 'Oro'), (17, 'Plata'), (29999, 'Oro'), (99999, 'Sin pareja')`);
    ctx = await createE2eApp();
    ws = await seedWorkspace(ctx, 'Excel');
  });

  afterAll(async () => {
    await source.query(`DROP TABLE IF EXISTS "${clientes}"`).catch(() => undefined);
    await source.end();
    await ctx?.close();
  });

  it(`sube un CSV de ${ROWS.toLocaleString('es')} filas: responde 202 y termina LISTO en segundo plano`, async () => {
    const response = await ctx
      .http()
      .post('/excel')
      .set(bearer(ws.users.OPERADOR))
      .field('nombre', 'Ventas masivas')
      .attach('archivo', csv(ROWS), 'ventas.csv')
      .expect(202);
    expect(response.body).toMatchObject({ nombre: 'Ventas masivas', estado: 'PROCESANDO', hojas: [] });
    excelId = response.body.id;

    const ready = await waitReady(excelId);
    expect(ready).toMatchObject({ estado: 'LISTO', progreso: 100, filasProcesadas: ROWS, error: null, avisos: [] });
    expect(ready.hojas).toEqual([
      { nombre: 'ventas', columnas: ['id', 'nombre', 'zona', 'monto'], columnaId: 'id', totalFilas: ROWS, tipos: ['numero', 'texto', 'texto', 'numero'] },
    ]);
    expect(await excelTables()).toHaveLength(1);
  });

  it('el LECTOR no puede subir archivos', async () => {
    await ctx.http().post('/excel').set(bearer(ws.users.LECTOR)).attach('archivo', csv(2), 'x.csv').expect(403);
  });

  it('explora la hoja por páginas con filtros ejecutados en PostgreSQL', async () => {
    const filtros = encodeURIComponent(JSON.stringify([{ campo: 'zona', operador: 'eq', valor: 'Sur' }]));
    const first = await ctx.http().get(`/engine/connections/${excelId}/data?entidad=ventas&limite=3&filtros=${filtros}`).set(bearer(ws.users.OPERADOR)).expect(200);
    expect(first.body.data.map((row: { id: number }) => row.id)).toEqual([2, 4, 6]);
    const second = await ctx
      .http()
      .get(`/engine/connections/${excelId}/data?entidad=ventas&limite=3&filtros=${filtros}&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set(bearer(ws.users.OPERADOR))
      .expect(200);
    expect(second.body.data.map((row: { id: number }) => row.id)).toEqual([8, 10, 12]);
  });

  it('cruza la hoja con PostgreSQL trayendo solo las filas cuya llave existe (semi-join)', async () => {
    const connection = await ctx
      .http()
      .post('/connections')
      .set(bearer(ws.users.ADMIN))
      .send({
        nombre: 'Clientes e2e',
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

    const join = await ctx
      .http()
      .post('/engine/join')
      .set(bearer(ws.users.OPERADOR))
      .send({
        fuentes: [
          { alias: 'clientes', conexionId: connection.body.id, entidad: clientes, esquema: 'public' },
          { alias: 'ventas', conexionId: excelId, entidad: 'ventas' },
        ],
        relaciones: [{ izquierda: 'clientes', derecha: 'ventas', tipo: 'INNER', llaves: [{ izquierda: 'id', derecha: 'id' }] }],
      });
    expect(join.status, JSON.stringify(join.body)).toBeLessThan(300);
    const rows = join.body.data;
    expect(rows.map((row: Record<string, unknown>) => row['ventas.nombre'] ?? row.nombre)).toEqual(['Cliente 5', 'Cliente 17', 'Cliente 29999']);
  });

  it('reemplaza el contenido conservando el id y elimina la tabla anterior', async () => {
    const before = await excelTables();
    await ctx.http().put(`/excel/${excelId}/archivo`).set(bearer(ws.users.ADMIN)).attach('archivo', csv(10), 'ventas.csv').expect(202);
    const ready = await waitReady(excelId);
    expect(ready).toMatchObject({ estado: 'LISTO', filasProcesadas: 10 });
    expect(ready.hojas[0].totalFilas).toBe(10);
    const after = await excelTables();
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
  });

  it('un archivo sin datos queda en ERROR con el motivo y sin tablas', async () => {
    const response = await ctx.http().post('/excel').set(bearer(ws.users.ADMIN)).attach('archivo', Buffer.from('\r\n\r\n'), 'vacio.csv').expect(202);
    const failed = await waitReady(response.body.id);
    expect(failed).toMatchObject({ estado: 'ERROR', hojas: [] });
    expect(failed.error).toMatch(/no tiene hojas con datos/);
    await ctx.http().delete(`/excel/${response.body.id}`).set(bearer(ws.users.ADMIN)).expect(204);
  });

  it('con EXCEL_DB_MAX_MB superado, la carga se detiene con un mensaje claro y la API sigue respondiendo', async () => {
    process.env.EXCEL_DB_MAX_MB = '1';
    try {
      const response = await ctx.http().post('/excel').set(bearer(ws.users.ADMIN)).attach('archivo', csv(50), 'grande.csv').expect(202);
      const failed = await waitReady(response.body.id);
      expect(failed).toMatchObject({ estado: 'ERROR', hojas: [] });
      expect(failed.error).toMatch(/espacio máximo configurado/);
      await ctx.http().delete(`/excel/${response.body.id}`).set(bearer(ws.users.ADMIN)).expect(204);
    } finally {
      delete process.env.EXCEL_DB_MAX_MB;
    }
    expect(await excelTables()).toHaveLength(1);
  });

  it('eliminar el archivo borra también sus tablas', async () => {
    await ctx.http().delete(`/excel/${excelId}`).set(bearer(ws.users.ADMIN)).expect(204);
    await ctx.http().get(`/excel/${excelId}`).set(bearer(ws.users.ADMIN)).expect(404);
    expect(await excelTables()).toEqual([]);
  });
});
