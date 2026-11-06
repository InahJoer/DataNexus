import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import type { MailService } from '../mailer/mail.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SavedQueriesService } from '../queries/saved-queries.service.js';
import { ReportExecutionsService } from './report-executions.service.js';
import type { ReportsService } from './reports.service.js';
import { ScheduledReportsService } from './scheduled-reports.service.js';

const owner = { id: 'user-1', email: 'autora@acme.com', name: 'Ana Autora', role: 'OPERADOR' };
const actor: AuthenticatedUser = { ...owner, role: 'OPERADOR', workspaceId: 'ws-1' };
const TRIGGERED_AT = new Date('2026-11-06T08:00:05Z');

const schedule = {
  id: 'sched-1',
  workspaceId: 'ws-1',
  savedQueryId: 'query-1',
  createdById: owner.id,
  nombre: 'Ventas diarias',
  frecuencia: 'DAILY',
  hora: '08:00',
  diaSemana: null,
  diaMes: null,
  zonaHoraria: 'UTC',
  formato: 'PDF',
  destinatarios: ['gerencia@acme.com'],
  enviarCorreo: true,
  estado: 'ACTIVE',
  lastRunAt: null,
  lastError: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  savedQuery: { nombre: 'Ventas' },
  workspace: { zonaHoraria: 'UTC' },
};

const generated = {
  reportTitle: 'Ventas diarias',
  recipients: ['gerencia@acme.com'],
  format: 'pdf',
  filename: 'datanexus_export_2026.pdf',
  totalRows: 120,
  fileSizeBytes: 48_213,
  downloadUrl: 'https://api.acme.com/reports/download/x',
  expiresAt: '2026-11-07T08:00:00.000Z',
  messageId: '<msg-1@acme.com>',
  deliveryAttempts: 1,
};

type Execution = Record<string, unknown> & { id: string; status: string };

/** Prisma en memoria, solo con lo que usa el servicio. */
function createPrisma() {
  const executions = new Map<string, Execution>();
  let sequence = 0;
  const matches = (execution: Execution, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && !(value instanceof Date)) return true; // lease: siempre vigente
      return execution[key] === value;
    });

  const prisma = {
    executions,
    reportExecution: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const execution: Execution = {
          id: `exec-${++sequence}`,
          status: 'RUNNING',
          attempts: 1,
          startedAt: new Date(Date.now() - 2_000),
          scheduledFor: null,
          finishedAt: null,
          durationMs: null,
          totalRows: null,
          fileSizeBytes: null,
          error: null,
          downloadUrl: null,
          expiresAt: null,
          messageId: null,
          authorNotifiedAt: null,
          titulo: null,
          formato: null,
          scheduledReportId: null,
          ...data,
        };
        executions.set(execution.id, execution);
        return execution;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const execution = executions.get(where.id as string);
        if (!execution || !matches(execution, where)) return { count: 0 };
        Object.assign(execution, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(executions.get(where.id)!, data),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...executions.get(where.id)! })),
      findMany: vi.fn(async () => [...executions.values()]),
      count: vi.fn().mockResolvedValue(0),
    },
    scheduledReport: {
      findFirst: vi.fn().mockResolvedValue(schedule),
      update: vi.fn().mockResolvedValue(schedule),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(owner),
      findMany: vi.fn().mockResolvedValue([{ email: 'gerencia@acme.com', role: 'ADMIN' }]),
    },
  };
  return prisma;
}

function setup() {
  const prisma = createPrisma();
  const reports = { triggerScheduledReport: vi.fn().mockResolvedValue(generated) };
  const savedQueries = {
    prepareRun: vi.fn().mockResolvedValue({ payload: { fuentes: [] }, query: { nombre: 'Ventas' } }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const mail = { sendMail: vi.fn().mockResolvedValue({ messageId: 'aviso-1', accepted: [owner.email], rejected: [] }) };
  const registry = { getCronJobs: () => new Map(), deleteCronJob: vi.fn(), addCronJob: vi.fn() };
  const service = new ScheduledReportsService(
    prisma as unknown as PrismaService,
    savedQueries as unknown as SavedQueriesService,
    reports as unknown as ReportsService,
    audit as unknown as AuditService,
    registry as unknown as SchedulerRegistry,
    mail as unknown as MailService,
    new ReportExecutionsService(prisma as unknown as PrismaService),
  );
  service.sleep = vi.fn().mockResolvedValue(undefined);
  const runScheduled = () =>
    (service as unknown as { runScheduled(id: string, at: Date): Promise<void> }).runScheduled(schedule.id, TRIGGERED_AT);
  const lastExecution = () => [...prisma.executions.values()].at(-1)!;
  return { service, prisma, reports, savedQueries, audit, mail, runScheduled, lastExecution };
}

describe('ScheduledReportsService – historial, reintentos y avisos (issue #39)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('cada ejecución queda registrada con estado, duración, tamaño, filas e intentos', async () => {
    await ctx.runScheduled();

    expect(ctx.prisma.reportExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: 'SCHEDULED',
        scheduledReportId: 'sched-1',
        titulo: 'Ventas diarias',
        formato: 'pdf',
        actorUserId: owner.id,
        idempotencyKey: 'sched-1:2026-11-06T08:00',
      }),
    });
    const execution = ctx.lastExecution();
    expect(execution).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
      totalRows: 120,
      fileSizeBytes: 48_213,
      messageId: '<msg-1@acme.com>',
      error: null,
      leaseExpiresAt: null,
    });
    expect(execution.durationMs).toBeGreaterThanOrEqual(2_000);
    expect(ctx.mail.sendMail).not.toHaveBeenCalled();
  });

  it('reintenta fallos transitorios con backoff y guarda los intentos usados', async () => {
    ctx.reports.triggerScheduledReport
      .mockRejectedValueOnce(new BadGatewayException('fuente caída'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(generated);

    await ctx.runScheduled();

    expect(ctx.reports.triggerScheduledReport).toHaveBeenCalledTimes(3);
    expect(ctx.service.sleep).toHaveBeenCalledTimes(2);
    const [first, second] = (ctx.service.sleep as ReturnType<typeof vi.fn>).mock.calls.map(([ms]) => ms as number);
    expect(second).toBe(first * 2);
    expect(ctx.lastExecution()).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
    expect(ctx.mail.sendMail).not.toHaveBeenCalled();
  });

  it('suma los reenvíos de correo a los intentos', async () => {
    ctx.reports.triggerScheduledReport.mockResolvedValue({ ...generated, deliveryAttempts: 2 });

    await ctx.runScheduled();

    expect(ctx.lastExecution()).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
  });

  it('tras agotar los reintentos marca FAILED, pasa la programación a ERROR y avisa al autor', async () => {
    ctx.reports.triggerScheduledReport.mockRejectedValue(new BadGatewayException('host db.interna:5432 caído'));

    await ctx.runScheduled();

    const execution = ctx.lastExecution();
    expect(execution).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      error: 'No se pudo generar el reporte. Revise la consulta y las conexiones del workspace.',
    });
    expect(JSON.stringify(execution)).not.toContain('db.interna');
    expect(ctx.prisma.scheduledReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'ERROR' }) }),
    );

    expect(ctx.mail.sendMail).toHaveBeenCalledOnce();
    const notice = ctx.mail.sendMail.mock.calls[0][0];
    expect(notice.to).toBe(owner.email);
    expect(notice.subject).toBe('[DataNexus] Falló el reporte "Ventas diarias"');
    expect(notice.text).toContain('falló después de 3 intentos');
    expect(notice.html).toContain('Ana Autora');
    expect(execution.authorNotifiedAt).toBeInstanceOf(Date);
  });

  it('no reintenta errores de configuración (destinatario AUDITOR)', async () => {
    ctx.prisma.user.findMany.mockResolvedValue([{ email: 'gerencia@acme.com', role: 'AUDITOR' }]);

    await ctx.runScheduled();

    expect(ctx.reports.triggerScheduledReport).not.toHaveBeenCalled();
    expect(ctx.service.sleep).not.toHaveBeenCalled();
    expect(ctx.lastExecution()).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(ctx.mail.sendMail).toHaveBeenCalledOnce();
  });

  it('si solo falla el correo, registra el fallo de entrega y avisa al autor sin desactivar la programación', async () => {
    ctx.reports.triggerScheduledReport.mockResolvedValue({
      ...generated,
      messageId: undefined,
      deliveryError: 'El reporte se generó, pero falló la entrega por correo.',
      deliveryAttempts: 3,
    });

    await ctx.runScheduled();

    expect(ctx.lastExecution()).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      error: 'El reporte se generó, pero no se pudo enviar el correo.',
      fileSizeBytes: 48_213,
    });
    expect(ctx.prisma.scheduledReport.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'ERROR' }) }),
    );
    expect(ctx.mail.sendMail).toHaveBeenCalledOnce();
  });

  it('un fallo al enviar el aviso no cambia el resultado registrado', async () => {
    ctx.reports.triggerScheduledReport.mockRejectedValue(new BadRequestException('consulta inválida'));
    ctx.mail.sendMail.mockRejectedValue(new Error('SMTP caído'));

    await ctx.runScheduled();

    expect(ctx.lastExecution()).toMatchObject({ status: 'FAILED', authorNotifiedAt: null });
  });

  it('"Ejecutar ahora" registra la ejecución MANUAL y no envía aviso: el usuario ve el fallo', async () => {
    ctx.reports.triggerScheduledReport.mockRejectedValue(new BadRequestException('consulta inválida'));

    const result = await ctx.service.runNow(actor, schedule.id);

    expect(result).toMatchObject({ trigger: 'MANUAL', status: 'FAILED', attempts: 1, titulo: 'Ventas diarias' });
    expect(result).not.toHaveProperty('idempotencyKey');
    expect(result).not.toHaveProperty('leaseExpiresAt');
    expect(ctx.mail.sendMail).not.toHaveBeenCalled();
  });

  it('recupera ejecuciones interrumpidas, también las bajo demanda sin programación', async () => {
    const now = new Date();
    ctx.prisma.reportExecution.findMany.mockResolvedValueOnce([
      {
        id: 'exec-od', workspaceId: 'ws-1', scheduledReportId: null, trigger: 'ON_DEMAND',
        startedAt: new Date(now.getTime() - 600_000), attempts: 1, scheduledReport: null,
      },
      {
        id: 'exec-sc', workspaceId: 'ws-1', scheduledReportId: 'sched-1', trigger: 'SCHEDULED',
        startedAt: new Date(now.getTime() - 600_000), attempts: 2, scheduledReport: schedule,
      },
    ] as never);
    ctx.prisma.executions.set('exec-od', { id: 'exec-od', status: 'RUNNING' });
    ctx.prisma.executions.set('exec-sc', { id: 'exec-sc', status: 'RUNNING' });

    await (ctx.service as unknown as { recoverAbandonedRuns(now: Date): Promise<void> }).recoverAbandonedRuns(now);

    expect(ctx.prisma.executions.get('exec-od')).toMatchObject({ status: 'FAILED', durationMs: 600_000 });
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'REPORT', targetId: 'exec-od' }),
    );
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'SCHEDULED_REPORT', targetId: 'sched-1' }),
    );
    expect(ctx.prisma.scheduledReport.updateMany).toHaveBeenCalledOnce();
    expect(ctx.mail.sendMail).toHaveBeenCalledOnce();
  });

  it('lista el historial de la programación con filtros y enlaces solo vigentes', async () => {
    ctx.prisma.reportExecution.findMany.mockResolvedValueOnce([
      { ...ctx.lastExecution?.(), id: 'e1', status: 'SUCCEEDED', expiresAt: new Date(Date.now() - 1), downloadUrl: 'https://x/old' },
    ] as never);

    const list = await ctx.service.listExecutions(actor, schedule.id, { status: 'SUCCEEDED', limit: 10 });

    expect(ctx.prisma.reportExecution.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', scheduledReportId: 'sched-1', status: 'SUCCEEDED' },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
    expect(list[0]).toMatchObject({ id: 'e1', downloadUrl: null });
  });
});
