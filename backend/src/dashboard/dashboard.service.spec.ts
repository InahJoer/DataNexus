import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import type { UserRole } from '../auth/interfaces/user-role.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ScheduledReportsService } from '../reports/scheduled-reports.service.js';
import type { UsageMeterService } from '../usage/usage-meter.service.js';
import { DASHBOARD_CACHE_TTL_MS, DashboardService } from './dashboard.service.js';
import type { PlatformHealthService } from './platform-health.service.js';

const NOW = new Date('2026-11-06T18:00:00Z');
const user = (role: UserRole, id = `${role.toLowerCase()}-1`): AuthenticatedUser => ({
  id,
  email: `${id}@acme.com`,
  name: id,
  role,
  workspaceId: 'ws-1',
});

const IDS = { erp: 'c-erp', app: 'c-app', crm: 'c-crm', fs: 'c-fs', nuevo: 'c-new' };
const checkedAt = new Date('2026-11-06T17:59:30Z');
const connections = [
  { id: IDS.erp, nombre: 'ERP Producción', tipoMotor: 'SQLSERVER', host: 'erp', dbName: 'erp', ultimoHealthStatus: 'HEALTHY', ultimaLatenciaMs: 24, ultimoHealthAt: checkedAt },
  { id: IDS.app, nombre: null, tipoMotor: 'POSTGRESQL', host: 'pg.acme', dbName: 'eventos', ultimoHealthStatus: 'HEALTHY', ultimaLatenciaMs: 162, ultimoHealthAt: checkedAt },
  { id: IDS.fs, nombre: 'Eventos App', tipoMotor: 'FIRESTORE', host: 'p', dbName: '(default)', ultimoHealthStatus: 'HEALTHY', ultimaLatenciaMs: 62, ultimoHealthAt: checkedAt },
  { id: IDS.crm, nombre: 'CRM Legado', tipoMotor: 'SQLSERVER', host: 'crm', dbName: 'crm', ultimoHealthStatus: 'UNAVAILABLE', ultimaLatenciaMs: 10_000, ultimoHealthAt: checkedAt },
  { id: IDS.nuevo, nombre: 'Nueva', tipoMotor: 'MYSQL', host: 'm', dbName: 'm', ultimoHealthStatus: null, ultimaLatenciaMs: null, ultimoHealthAt: null },
];

function usageRow(day: string, solicitudesApi: number) {
  return { dia: new Date(`${day}T00:00:00Z`), solicitudesApi };
}

function setup() {
  const prisma = {
    workspace: { findUnique: vi.fn().mockResolvedValue({ zonaHoraria: 'America/Managua' }) },
    conexionDB: { findMany: vi.fn().mockResolvedValue(connections) },
    registroAuditoria: {
      count: vi.fn(async ({ where }: { where: { eventType: string; createdAt: { gte: Date } } }) => {
        const currentMonth = where.createdAt.gte.getTime() === new Date('2026-11-01T06:00:00Z').getTime();
        if (where.eventType === 'EXECUTE_JOIN') return currentMonth ? 1284 : 1083;
        return currentMonth ? 40 : 0;
      }),
      findFirst: vi.fn().mockResolvedValue({ createdAt: new Date('2026-11-06T17:58:00Z') }),
      findMany: vi.fn().mockResolvedValue([
        { id: 'a1', eventType: 'EXECUTE_JOIN', outcome: 'SUCCESS', actorEmail: 'ana@acme.com', targetType: 'CROSS_JOIN', createdAt: new Date('2026-11-06T17:58:00Z') },
        { id: 'a2', eventType: 'EVENTO_FUTURO', outcome: 'FAILURE', actorEmail: null, targetType: null, createdAt: new Date('2026-11-06T17:00:00Z') },
      ]),
    },
    workspaceUsageDaily: {
      aggregate: vi.fn(async ({ where }: { where: { dia: { gte: Date } } }) => ({
        _sum: { bytesProcesados: where.dia.gte.toISOString().startsWith('2026-11') ? 900n * 1024n ** 3n : 800n * 1024n ** 3n },
      })),
      findMany: vi.fn().mockResolvedValue([
        usageRow('2026-10-24', 1000),
        usageRow('2026-10-30', 1000),
        usageRow('2026-10-31', 2000),
        usageRow('2026-11-06', 3000),
      ]),
    },
    savedQuery: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'q1',
          nombre: 'Ventas y eventos por cliente',
          definicion: { fuentes: [{ conexionId: IDS.erp }, { conexionId: IDS.fs }, { conexionId: 'c-borrada' }] },
          updatedAt: new Date('2026-11-06T17:48:00Z'),
          autor: { name: 'Ana Martínez' },
        },
        {
          id: 'q2',
          nombre: 'Formato original',
          definicion: { conexionSqlId: IDS.app, conexionNoSqlId: IDS.fs },
          updatedAt: new Date('2026-11-05T10:00:00Z'),
          autor: null,
        },
      ]),
    },
  };
  const scheduledReports = {
    upcoming: vi.fn().mockResolvedValue([{ id: 's1', nombre: 'Diario', formato: 'pdf', nextRunAt: '2026-11-07T14:00:00.000Z' }]),
  };
  const platformHealth = {
    check: vi.fn().mockResolvedValue([
      { servicio: 'Base de datos', estado: 'OPERATIVO', detalle: 'PostgreSQL responde', latenciaMs: 2 },
      { servicio: 'Cola de trabajos', estado: 'NO_CONFIGURADO', detalle: 'Sin REDIS_URL', latenciaMs: null },
    ]),
  };
  const usageMeter = {
    pendingFor: vi.fn().mockReturnValue([{ workspaceId: 'ws-1', day: '2026-11-06', apiRequests: 5, bytesProcessed: 1024 }]),
  };
  const service = new DashboardService(
    prisma as unknown as PrismaService,
    scheduledReports as unknown as ScheduledReportsService,
    platformHealth as unknown as PlatformHealthService,
    usageMeter as unknown as UsageMeterService,
  );
  return { service, prisma, scheduledReports, platformHealth };
}

describe('DashboardService – GET /dashboard/summary (issue #40)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resume conexiones activas/caídas, motores, atención y latencias con umbral', async () => {
    const summary = await ctx.service.getSummary(user('ADMIN'), NOW);

    expect(summary.conexiones).toMatchObject({
      total: 5,
      activas: 3,
      caidas: 1,
      sinComprobar: 1,
      motoresConectados: ['FIRESTORE', 'POSTGRESQL', 'SQLSERVER'],
      umbralLatenciaMs: 100,
      ultimaComprobacion: checkedAt.toISOString(),
    });
    expect(summary.conexiones?.requierenAtencion).toEqual([
      { id: IDS.crm, nombre: 'CRM Legado', tipoMotor: 'SQLSERVER', estado: 'UNAVAILABLE', ultimoHealthAt: checkedAt.toISOString() },
    ]);
    expect(summary.conexiones?.latencias.map((item) => [item.nombre, item.latenciaMs, item.superaUmbral])).toEqual([
      ['ERP Producción', 24, false],
      ['Eventos App', 62, false],
      ['eventos · pg.acme', 162, true],
    ]);
    expect(summary.entorno.conexionesConError).toBe(1);
  });

  it('cuenta Cross-Joins y exportaciones del mes local con su variación', async () => {
    const summary = await ctx.service.getSummary(user('ADMIN'), NOW);

    expect(summary.zonaHoraria).toBe('America/Managua');
    expect(summary.periodo).toEqual({
      mes: '2026-11',
      inicio: '2026-11-01T06:00:00.000Z',
      fin: '2026-12-01T06:00:00.000Z',
    });
    expect(summary.crossJoins).toEqual({
      mesActual: 1284,
      mesAnterior: 1083,
      variacionPct: 18.6,
      ultimaEjecucion: '2026-11-06T17:58:00.000Z',
    });
    expect(summary.exportaciones).toEqual({ mesActual: 40, mesAnterior: 0, variacionPct: null });
    expect(ctx.prisma.registroAuditoria.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ workspaceId: 'ws-1', eventType: 'EXECUTE_JOIN', outcome: 'SUCCESS' }),
    });
  });

  it('compara los datos procesados con el límite del plan e incluye lo aún no volcado', async () => {
    vi.stubEnv('WORKSPACE_DATA_LIMIT_GB', '1024');
    const summary = await ctx.service.getSummary(user('ADMIN'), NOW);

    expect(summary.datosProcesados).toEqual({
      bytesMesActual: 900 * 1024 ** 3 + 1024,
      bytesMesAnterior: 800 * 1024 ** 3,
      variacionPct: 12.5,
      limitePlanBytes: 1024 * 1024 ** 3,
      usoPlanPct: 87.9,
    });
  });

  it('agrupa el consumo de API en los últimos 7 días y lo compara con la semana anterior', async () => {
    const summary = await ctx.service.getSummary(user('ADMIN'), NOW);

    expect(summary.consumoApi.dias).toEqual([
      { dia: '2026-10-31', solicitudes: 2000 },
      { dia: '2026-11-01', solicitudes: 0 },
      { dia: '2026-11-02', solicitudes: 0 },
      { dia: '2026-11-03', solicitudes: 0 },
      { dia: '2026-11-04', solicitudes: 0 },
      { dia: '2026-11-05', solicitudes: 0 },
      { dia: '2026-11-06', solicitudes: 3005 },
    ]);
    expect(summary.consumoApi).toMatchObject({ totalSemana: 5005, totalSemanaAnterior: 2000, variacionPct: 150.3 });
  });

  it('lista consultas recientes con sus motores, reportes próximos, actividad y entorno', async () => {
    const summary = await ctx.service.getSummary(user('ADMIN'), NOW);

    expect(summary.consultasRecientes).toEqual([
      {
        id: 'q1',
        nombre: 'Ventas y eventos por cliente',
        fuentes: ['SQLSERVER', 'FIRESTORE'],
        autor: 'Ana Martínez',
        actualizadaEn: '2026-11-06T17:48:00.000Z',
      },
      { id: 'q2', nombre: 'Formato original', fuentes: ['POSTGRESQL', 'FIRESTORE'], autor: null, actualizadaEn: '2026-11-05T10:00:00.000Z' },
    ]);
    expect(summary.reportesProximos).toEqual([
      { id: 's1', nombre: 'Diario', formato: 'pdf', proximaEjecucion: '2026-11-07T14:00:00.000Z' },
    ]);
    expect(summary.actividadReciente[0]).toMatchObject({ descripcion: 'Ejecutó un Cross-Join', actor: 'ana@acme.com' });
    expect(summary.actividadReciente[1].descripcion).toBe('EVENTO_FUTURO');
    expect(summary.entorno.estadoGeneral).toBe('OPERATIVO');
  });

  it('el AUDITOR no recibe conexiones, consultas ni reportes, pero sí la bitácora completa', async () => {
    const summary = await ctx.service.getSummary(user('AUDITOR'), NOW);

    expect(summary.conexiones).toBeNull();
    expect(summary.consultasRecientes).toBeNull();
    expect(summary.reportesProximos).toBeNull();
    expect(summary.entorno.conexionesConError).toBeNull();
    expect(ctx.prisma.savedQuery.findMany).not.toHaveBeenCalled();
    expect(ctx.scheduledReports.upcoming).not.toHaveBeenCalled();
    expect(ctx.prisma.registroAuditoria.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 'ws-1' });
  });

  it('el LECTOR solo ve consultas publicadas y su propia actividad', async () => {
    const lector = user('LECTOR');
    const summary = await ctx.service.getSummary(lector, NOW);

    expect(summary.conexiones).toBeNull();
    expect(ctx.prisma.savedQuery.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 'ws-1', visibilidad: 'PUBLICADA' });
    expect(ctx.prisma.registroAuditoria.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: 'ws-1',
      actorUserId: lector.id,
    });
  });

  it('cachea 60 s por workspace y rol, y vuelve a calcular al vencer', async () => {
    const admin = user('ADMIN');
    const first = await ctx.service.getSummary(admin, NOW);
    const second = await ctx.service.getSummary(admin, new Date(NOW.getTime() + DASHBOARD_CACHE_TTL_MS - 1));
    expect(second).toBe(first);
    expect(ctx.prisma.conexionDB.findMany).toHaveBeenCalledTimes(1);

    await ctx.service.getSummary(user('OPERADOR'), NOW);
    expect(ctx.prisma.conexionDB.findMany).toHaveBeenCalledTimes(2);

    const third = await ctx.service.getSummary(admin, new Date(NOW.getTime() + DASHBOARD_CACHE_TTL_MS));
    expect(third).not.toBe(first);
    expect(third.cacheHasta).toBe(new Date(NOW.getTime() + 2 * DASHBOARD_CACHE_TTL_MS).toISOString());
  });

  it('separa la caché por usuario cuando la actividad es personal', async () => {
    await ctx.service.getSummary(user('OPERADOR', 'op-1'), NOW);
    await ctx.service.getSummary(user('OPERADOR', 'op-2'), NOW);
    expect(ctx.prisma.registroAuditoria.findMany).toHaveBeenCalledTimes(2);
  });

  it('no cachea un fallo', async () => {
    ctx.prisma.conexionDB.findMany.mockRejectedValueOnce(new Error('db caída'));
    await expect(ctx.service.getSummary(user('ADMIN'), NOW)).rejects.toThrow('db caída');
    await expect(ctx.service.getSummary(user('ADMIN'), NOW)).resolves.toBeTruthy();
  });

  it('usa UTC si la zona horaria del workspace no es válida', async () => {
    ctx.prisma.workspace.findUnique.mockResolvedValue({ zonaHoraria: 'Marte/Olympus' });
    const summary = await ctx.service.getSummary(user('ADMIN'), NOW);
    expect(summary.zonaHoraria).toBe('UTC');
    expect(summary.periodo.inicio).toBe('2026-11-01T00:00:00.000Z');
  });

  it('marca el entorno con el peor estado de los servicios', async () => {
    ctx.platformHealth.check.mockResolvedValue([
      { servicio: 'Base de datos', estado: 'DEGRADADO', detalle: 'lento', latenciaMs: 200 },
      { servicio: 'Cola de trabajos', estado: 'CAIDO', detalle: 'Redis no responde', latenciaMs: null },
    ]);
    const summary = await ctx.service.getSummary(user('ADMIN'), NOW);
    expect(summary.entorno.estadoGeneral).toBe('CAIDO');
  });
});
