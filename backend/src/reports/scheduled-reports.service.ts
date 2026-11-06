import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { Prisma, ScheduledReportRun } from '@prisma/client';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission, isUserRole } from '../auth/interfaces/user-role.js';
import { AuditService } from '../audit/audit.service.js';
import { SavedQueriesService } from '../queries/saved-queries.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReportsService } from './reports.service.js';
import type {
  CreateScheduledReportDto,
  ScheduledReportFrequencyDto,
  ScheduledReportFormatDto,
  ScheduledReportResponseDto,
  ScheduledReportRunResponseDto,
  ScheduledReportsSummaryDto,
  UpdateScheduledReportDto,
} from './dto/scheduled-report.dto.js';

const SCHEDULE_INCLUDE = {
  savedQuery: { select: { nombre: true } },
  workspace: { select: { zonaHoraria: true } },
} satisfies Prisma.ScheduledReportInclude;

type ScheduleRecord = Prisma.ScheduledReportGetPayload<{ include: typeof SCHEDULE_INCLUDE }>;
type ScheduleSettingsDto = CreateScheduledReportDto | UpdateScheduledReportDto;

const SAFE_RUN_ERROR = 'No se pudo generar el reporte. Revise la consulta y las conexiones del workspace.';
const SAFE_EMAIL_ERROR = 'El reporte se generó, pero no se pudo enviar el correo.';
const SAFE_INTERRUPTED_ERROR = 'La ejecución se interrumpió antes de terminar.';
const RUNS_PAGE_SIZE = 100;
const RUN_LEASE_MS = 5 * 60_000;
const RUN_LEASE_HEARTBEAT_MS = 60_000;
const MINUTE_MS = 60_000;

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function dbFrequency(value: ScheduledReportFrequencyDto) {
  return value.toUpperCase() as 'DAILY' | 'WEEKLY' | 'MONTHLY';
}

function dtoFrequency(value: ScheduleRecord['frecuencia']): ScheduledReportFrequencyDto {
  return value.toLowerCase() as ScheduledReportFrequencyDto;
}

function dbFormat(value: ScheduledReportFormatDto) {
  return value.toUpperCase() as 'EXCEL' | 'PDF' | 'JSON';
}

function dtoFormat(value: ScheduleRecord['formato']): ScheduledReportFormatDto {
  return value.toLowerCase() as ScheduledReportFormatDto;
}

function getDateParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)] as const),
  );
}

function startOfLocalDay(date: Date, timeZone: string): Date {
  const local = getDateParts(date, timeZone);
  const targetDay = Date.UTC(local.year, local.month - 1, local.day);
  const localDayAt = (timestamp: number) => {
    const parts = getDateParts(new Date(timestamp), timeZone);
    return Date.UTC(parts.year, parts.month - 1, parts.day);
  };

  let low = targetDay - 48 * 60 * 60_000;
  let high = targetDay + 48 * 60 * 60_000;
  while (localDayAt(low) >= targetDay) low -= 24 * 60 * 60_000;
  while (localDayAt(high) < targetDay) high += 24 * 60 * 60_000;

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDayAt(middle) < targetDay) low = middle;
    else high = middle;
  }
  return new Date(high);
}

@Injectable()
export class ScheduledReportsService implements OnModuleInit {
  private readonly logger = new Logger(ScheduledReportsService.name);
  private readonly registeredJobConfigs = new Map<string, string>();
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly savedQueries: SavedQueriesService,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const schedules = await this.prisma.scheduledReport.findMany({
      where: { estado: 'ACTIVE' },
      include: SCHEDULE_INCLUDE,
    });

    for (const schedule of schedules) {
      await this.syncJob(schedule);
    }
  }

  @Cron('*/10 * * * * *')
  private async pollSchedules(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const now = new Date();
    try {
      await this.recoverAbandonedRuns(now);
      const schedules = await this.prisma.scheduledReport.findMany({
        where: { estado: 'ACTIVE' },
        include: SCHEDULE_INCLUDE,
      });
      const activeIds = new Set<string>();
      for (const schedule of schedules) {
        activeIds.add(schedule.id);
        const current = await this.syncJob(schedule);
        if (current.estado === 'ACTIVE' && this.isDueAt(current, now)) {
          void this.runScheduled(current.id, now);
        }
      }
      for (const name of this.schedulerRegistry.getCronJobs().keys()) {
        if (!name.startsWith('scheduled-report-')) continue;
        const id = name.slice('scheduled-report-'.length);
        if (!activeIds.has(id)) this.removeJob(id);
      }
    } catch {
      this.logger.error('No se pudieron reconciliar las programaciones de reportes');
    } finally {
      this.polling = false;
    }
  }

  async create(
    actor: AuthenticatedUser,
    input: CreateScheduledReportDto,
    context: RequestAuditContext = {},
  ): Promise<ScheduledReportResponseDto> {
    this.assertCanManage(actor);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: actor.workspaceId },
      select: { zonaHoraria: true },
    });
    if (!workspace) throw new NotFoundException('Workspace no encontrado');

    const settings = this.resolveSettings(input, undefined, workspace.zonaHoraria);
    await this.assertSavedQuery(actor.workspaceId, settings.savedQueryId);
    if (settings.enviarCorreo) await this.assertRecipients(actor.workspaceId, settings.destinatarios);

    const created = await this.prisma.$transaction(async (tx) => {
      const schedule = await tx.scheduledReport.create({
        data: { ...settings, workspaceId: actor.workspaceId, createdById: actor.id },
        include: SCHEDULE_INCLUDE,
      });
      await this.audit.record(
        {
          eventType: 'SCHEDULED_REPORT_CREATED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'SCHEDULED_REPORT',
          targetId: schedule.id,
          details: {
            title: schedule.nombre,
            frequency: schedule.frecuencia,
            format: schedule.formato,
            recipientsCount: schedule.destinatarios.length,
          },
          ...context,
        },
        tx,
      );
      return schedule;
    });

    return this.toResponse(await this.syncJob(created));
  }

  async findAll(actor: AuthenticatedUser): Promise<ScheduledReportResponseDto[]> {
    this.assertCanManage(actor);
    const schedules = await this.prisma.scheduledReport.findMany({
      where: { workspaceId: actor.workspaceId },
      include: SCHEDULE_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });
    return schedules.map((schedule) => this.toResponse(schedule));
  }

  async findOne(actor: AuthenticatedUser, id: string): Promise<ScheduledReportResponseDto> {
    this.assertCanManage(actor);
    return this.toResponse(await this.findSchedule(actor.workspaceId, id));
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateScheduledReportDto,
    context: RequestAuditContext = {},
  ): Promise<ScheduledReportResponseDto> {
    this.assertCanManage(actor);
    const current = await this.findSchedule(actor.workspaceId, id);
    const settings = this.resolveSettings(input, current, current.workspace.zonaHoraria);
    await this.assertSavedQuery(actor.workspaceId, settings.savedQueryId);
    if (settings.enviarCorreo) await this.assertRecipients(actor.workspaceId, settings.destinatarios);

    const updated = await this.prisma.$transaction(async (tx) => {
      const schedule = await tx.scheduledReport.update({
        where: { id },
        data: settings,
        include: SCHEDULE_INCLUDE,
      });
      await this.audit.record(
        {
          eventType: 'SCHEDULED_REPORT_UPDATED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'SCHEDULED_REPORT',
          targetId: id,
          details: { changedFields: Object.keys(input) },
          ...context,
        },
        tx,
      );
      return schedule;
    });

    return this.toResponse(await this.syncJob(updated));
  }

  async remove(
    actor: AuthenticatedUser,
    id: string,
    context: RequestAuditContext = {},
  ): Promise<{ id: string; reportTitle: string }> {
    this.assertCanManage(actor);
    const schedule = await this.findSchedule(actor.workspaceId, id);
    await this.prisma.$transaction(async (tx) => {
      await this.audit.record(
        {
          eventType: 'SCHEDULED_REPORT_DELETED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'SCHEDULED_REPORT',
          targetId: id,
          details: { title: schedule.nombre },
          ...context,
        },
        tx,
      );
      await tx.scheduledReport.delete({ where: { id } });
    });
    this.removeJob(id);
    return { id, reportTitle: schedule.nombre };
  }

  async pause(
    actor: AuthenticatedUser,
    id: string,
    context: RequestAuditContext = {},
  ): Promise<ScheduledReportResponseDto> {
    this.assertCanManage(actor);
    const current = await this.findSchedule(actor.workspaceId, id);
    const updated = await this.updateStatus(actor, current, 'PAUSED', context);
    this.removeJob(id);
    return this.toResponse(updated);
  }

  async resume(
    actor: AuthenticatedUser,
    id: string,
    context: RequestAuditContext = {},
  ): Promise<ScheduledReportResponseDto> {
    this.assertCanManage(actor);
    const current = await this.findSchedule(actor.workspaceId, id);
    this.validateCronConfig(current);
    const updated = await this.updateStatus(actor, current, 'ACTIVE', context, actor.id);
    return this.toResponse(await this.syncJob(updated));
  }

  async runNow(
    actor: AuthenticatedUser,
    id: string,
    context: RequestAuditContext = {},
  ): Promise<ScheduledReportRunResponseDto> {
    this.assertCanManage(actor);
    const schedule = await this.findSchedule(actor.workspaceId, id);
    const run = await this.prisma.scheduledReportRun.create({
      data: {
        workspaceId: actor.workspaceId,
        scheduledReportId: id,
        trigger: 'MANUAL',
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
      },
    });
    const result = await this.executeRun(schedule, run.id, actor, 'MANUAL', context);
    return this.toRunResponse(result);
  }

  async listRuns(actor: AuthenticatedUser, id: string): Promise<ScheduledReportRunResponseDto[]> {
    this.assertCanManage(actor);
    await this.findSchedule(actor.workspaceId, id);
    const runs = await this.prisma.scheduledReportRun.findMany({
      where: { workspaceId: actor.workspaceId, scheduledReportId: id },
      orderBy: { startedAt: 'desc' },
      take: RUNS_PAGE_SIZE,
    });
    return runs.map((run) => this.toRunResponse(run));
  }

  async summary(actor: AuthenticatedUser): Promise<ScheduledReportsSummaryDto> {
    this.assertCanManage(actor);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: actor.workspaceId },
      select: { zonaHoraria: true },
    });
    if (!workspace) throw new NotFoundException('Workspace no encontrado');
    const now = new Date();
    const startToday = startOfLocalDay(now, workspace.zonaHoraria);
    const [counts, executionsToday, activeSchedules] = await Promise.all([
      this.prisma.scheduledReport.groupBy({
        by: ['estado'],
        where: { workspaceId: actor.workspaceId },
        _count: { _all: true },
      }),
      this.prisma.scheduledReportRun.count({
        where: { workspaceId: actor.workspaceId, startedAt: { gte: startToday, lte: now } },
      }),
      this.prisma.scheduledReport.findMany({
        where: { workspaceId: actor.workspaceId, estado: 'ACTIVE' },
        include: SCHEDULE_INCLUDE,
      }),
    ]);

    const countsByStatus = new Map(counts.map((row) => [row.estado, row._count._all]));
    const nextExecutionAt = activeSchedules
      .map((schedule) => this.nextRunAt(schedule))
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;

    return {
      active: countsByStatus.get('ACTIVE') ?? 0,
      paused: countsByStatus.get('PAUSED') ?? 0,
      error: countsByStatus.get('ERROR') ?? 0,
      executionsToday,
      nextExecutionAt,
    };
  }

  private async runScheduled(id: string, triggeredAt = new Date()): Promise<void> {
    try {
      const scheduledFor = new Date(Math.floor(triggeredAt.getTime() / MINUTE_MS) * MINUTE_MS);
      const schedule = await this.prisma.scheduledReport.findFirst({
        where: { id, estado: 'ACTIVE' },
        include: SCHEDULE_INCLUDE,
      });
      if (!schedule || !this.isDueAt(schedule, triggeredAt)) return;

      const local = getDateParts(triggeredAt, schedule.zonaHoraria);
      const localDate = `${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
      const idempotencyKey = `${id}:${localDate}T${schedule.hora}`;
      let run: ScheduledReportRun;
      try {
        run = await this.prisma.scheduledReportRun.create({
          data: {
            workspaceId: schedule.workspaceId,
            scheduledReportId: schedule.id,
            trigger: 'SCHEDULED',
            scheduledFor,
            idempotencyKey,
            leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
          },
        });
      } catch (error) {
        if (isUniqueConflict(error)) return;
        throw error;
      }

      const owner = await this.getCurrentOwner(schedule);
      if (!owner) {
        await this.finishFailedRun(schedule, run.id, 'El propietario ya no tiene permiso para ejecutar reportes.', true);
        this.removeJob(id);
        return;
      }

      await this.executeRun(schedule, run.id, owner, 'SCHEDULED');
    } catch (error) {
      this.logger.error(`No se pudo iniciar la ejecución programada ${id}`);
    }
  }

  private async executeRun(
    schedule: ScheduleRecord,
    runId: string,
    actor: AuthenticatedUser,
    trigger: 'SCHEDULED' | 'MANUAL',
    context: RequestAuditContext = {},
  ) {
    const stopHeartbeat = this.startLeaseHeartbeat(runId);
    try {
      const leaseHeld = await this.renewRunLease(runId);
      if (!leaseHeld) {
        return await this.prisma.scheduledReportRun.findUniqueOrThrow({ where: { id: runId } });
      }
      const prepared = await this.savedQueries.prepareRun(actor, schedule.savedQueryId, {});
      const recipientRoles = schedule.enviarCorreo
        ? await this.recipientRoles(schedule.workspaceId, schedule.destinatarios)
        : [];
      if (recipientRoles.includes('AUDITOR')) {
        throw new BadRequestException('AUDITOR no puede recibir reportes de datos de negocio');
      }
      const maskAsRole = recipientRoles.some((role) => role === 'LECTOR' || role === null)
        ? 'LECTOR'
        : actor.role;

      const result = await this.reports.triggerScheduledReport(
        actor,
        {
          reportTitle: schedule.nombre,
          recipients: schedule.destinatarios,
          format: dtoFormat(schedule.formato),
          crossJoinParams: prepared.payload,
          customMessage: `Reporte programado de la consulta ${prepared.query.nombre}.`,
        },
        { maskAsRole, sendEmail: schedule.enviarCorreo },
      );

      const deliveryFailed = result.deliveryError !== undefined;
      const finishedAt = new Date();
      const completed = await this.prisma.scheduledReportRun.updateMany({
        where: { id: runId, status: 'RUNNING', leaseExpiresAt: { gt: finishedAt } },
        data: {
          status: deliveryFailed ? 'FAILED' : 'SUCCEEDED',
          finishedAt,
          leaseExpiresAt: null,
          totalRows: result.totalRows,
          error: deliveryFailed ? SAFE_EMAIL_ERROR : null,
          downloadUrl: result.downloadUrl,
          expiresAt: new Date(result.expiresAt),
          messageId: result.messageId ?? null,
        },
      });
      if (completed.count === 0) {
        return await this.finishFailedRun(
          schedule,
          runId,
          SAFE_INTERRUPTED_ERROR,
          false,
          actor,
          trigger,
          context,
        );
      }
      const run = await this.prisma.scheduledReportRun.findUniqueOrThrow({ where: { id: runId } });
      if (trigger === 'SCHEDULED') {
        await this.prisma.scheduledReport.update({
          where: { id: schedule.id },
          data: {
            lastRunAt: finishedAt,
            lastError: deliveryFailed ? SAFE_EMAIL_ERROR : null,
          },
        });
      }
      await this.recordRunAudit(actor, schedule, run.id, trigger, deliveryFailed ? 'FAILURE' : 'SUCCESS', {
        format: schedule.formato,
        totalRows: result.totalRows,
        deliveryFailed,
      }, context);
      return run;
    } catch {
      const run = await this.finishFailedRun(schedule, runId, SAFE_RUN_ERROR, trigger === 'SCHEDULED', actor, trigger, context);
      if (trigger === 'SCHEDULED') this.removeJob(schedule.id);
      return run;
    } finally {
      stopHeartbeat();
    }
  }

  private startLeaseHeartbeat(runId: string): () => void {
    const timer = setInterval(() => {
      void this.renewRunLease(runId).catch(() => this.logger.error(`No se pudo renovar la ejecución ${runId}`));
    }, RUN_LEASE_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async renewRunLease(runId: string): Promise<boolean> {
    const now = new Date();
    const renewed = await this.prisma.scheduledReportRun.updateMany({
      where: { id: runId, status: 'RUNNING', leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_MS) },
    });
    return renewed.count > 0;
  }

  private async recoverAbandonedRuns(now: Date): Promise<void> {
    const abandoned = await this.prisma.scheduledReportRun.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: now } },
      select: {
        id: true,
        workspaceId: true,
        scheduledReportId: true,
        trigger: true,
        startedAt: true,
      },
    });
    for (const run of abandoned) {
      const recovered = await this.prisma.scheduledReportRun.updateMany({
        where: { id: run.id, status: 'RUNNING', leaseExpiresAt: { lt: now } },
        data: {
          status: 'FAILED',
          finishedAt: now,
          leaseExpiresAt: null,
          error: SAFE_INTERRUPTED_ERROR,
        },
      });
      if (recovered.count === 0) continue;

      if (run.trigger === 'SCHEDULED') {
        await this.prisma.scheduledReport.updateMany({
          where: { id: run.scheduledReportId },
          data: { lastRunAt: run.startedAt, lastError: SAFE_INTERRUPTED_ERROR },
        });
      }
      await this.audit.record({
        eventType: 'SCHEDULED_REPORT_RUN',
        outcome: 'FAILURE',
        actorEmail: 'system@datanexus.local',
        workspaceId: run.workspaceId,
        targetType: 'SCHEDULED_REPORT',
        targetId: run.scheduledReportId,
        details: {
          executionId: run.id,
          trigger: run.trigger,
          error: SAFE_INTERRUPTED_ERROR,
        },
      });
    }
  }

  private async finishFailedRun(
    schedule: ScheduleRecord,
    runId: string,
    message: string,
    disableSchedule: boolean,
    actor?: AuthenticatedUser,
    trigger: 'SCHEDULED' | 'MANUAL' = 'SCHEDULED',
    context: RequestAuditContext = {},
  ) {
    const finishedAt = new Date();
    const failed = await this.prisma.scheduledReportRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt, leaseExpiresAt: null, error: message },
    });
    const run = await this.prisma.scheduledReportRun.findUniqueOrThrow({ where: { id: runId } });
    if (failed.count === 0) return run;
    if (trigger === 'SCHEDULED') {
      await this.prisma.scheduledReport.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: finishedAt,
          lastError: disableSchedule || message === SAFE_INTERRUPTED_ERROR ? message : schedule.lastError,
          ...(disableSchedule ? { estado: 'ERROR' as const } : {}),
        },
      });
    }
    const auditActor = actor ?? {
      id: schedule.createdById ?? 'system',
      email: 'system@datanexus.local',
      name: 'DataNexus Scheduler',
      role: 'ADMIN' as const,
      workspaceId: schedule.workspaceId,
    };
    await this.recordRunAudit(auditActor, schedule, runId, trigger, 'FAILURE', { error: message }, context);
    if (disableSchedule) this.logger.error(`La programación ${schedule.id} quedó en ERROR: ${message}`);
    return run;
  }

  private async getCurrentOwner(schedule: ScheduleRecord): Promise<AuthenticatedUser | null> {
    if (!schedule.createdById) return null;
    const user = await this.prisma.user.findFirst({
      where: { id: schedule.createdById, workspaceId: schedule.workspaceId },
      select: { id: true, email: true, name: true, role: true },
    });
    if (!user || !isUserRole(user.role) || !hasPermission(user.role, 'MANAGE_REPORTS')) return null;
    return { ...user, role: user.role, workspaceId: schedule.workspaceId };
  }

  private async recipientRoles(workspaceId: string, recipients: string[]): Promise<Array<'ADMIN' | 'OPERADOR' | 'LECTOR' | 'AUDITOR' | null>> {
    if (recipients.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { workspaceId },
      select: { email: true, role: true },
    });
    const roleByEmail = new Map(users.map((user) => [user.email.toLowerCase(), user.role]));
    return recipients.map((email) => roleByEmail.get(email.toLowerCase()) ?? null);
  }

  private async assertRecipients(workspaceId: string, recipients: string[]): Promise<void> {
    const roles = await this.recipientRoles(workspaceId, recipients);
    if (roles.includes('AUDITOR')) {
      throw new BadRequestException('AUDITOR no puede recibir reportes de datos de negocio');
    }
  }

  private async assertSavedQuery(workspaceId: string, savedQueryId: string): Promise<void> {
    const query = await this.prisma.savedQuery.findFirst({
      where: { id: savedQueryId, workspaceId },
      select: { id: true },
    });
    if (!query) throw new NotFoundException('Consulta guardada no encontrada en el workspace');
  }

  private resolveSettings(
    input: ScheduleSettingsDto,
    current: ScheduleRecord | undefined,
    defaultTimezone: string,
  ) {
    const frequency = input.frequency ?? (current ? dtoFrequency(current.frecuencia) : undefined);
    const time = input.time ?? current?.hora;
    const savedQueryId = input.savedQueryId ?? current?.savedQueryId;
    const reportTitle = input.reportTitle ?? current?.nombre;
    const format = input.format ?? (current ? dtoFormat(current.formato) : undefined);
    const timezone = input.timezone ?? current?.zonaHoraria ?? defaultTimezone;
    const recipients = (input.recipients ?? current?.destinatarios ?? []).map((email) => email.trim().toLowerCase());
    const sendEmail = input.sendEmail ?? current?.enviarCorreo ?? true;

    if (!frequency || !time || !savedQueryId || !reportTitle || !reportTitle.trim() || !format) {
      throw new BadRequestException('Faltan campos requeridos de la programación');
    }
    if (sendEmail && recipients.length === 0) {
      throw new BadRequestException('Agregue al menos un destinatario si el envío por correo está habilitado');
    }
    if (frequency === 'weekly' && input.dayOfWeek === undefined && current?.frecuencia !== 'WEEKLY') {
      throw new BadRequestException('dayOfWeek es obligatorio para una frecuencia weekly');
    }
    if (frequency === 'monthly' && input.dayOfMonth === undefined && current?.frecuencia !== 'MONTHLY') {
      throw new BadRequestException('dayOfMonth es obligatorio para una frecuencia monthly');
    }
    if (frequency === 'weekly' && input.dayOfMonth !== undefined) {
      throw new BadRequestException('dayOfMonth solo aplica a una frecuencia monthly');
    }
    if (frequency === 'monthly' && input.dayOfWeek !== undefined) {
      throw new BadRequestException('dayOfWeek solo aplica a una frecuencia weekly');
    }
    if (frequency === 'daily' && (input.dayOfWeek !== undefined || input.dayOfMonth !== undefined)) {
      throw new BadRequestException('Los campos de día solo aplican a frecuencias weekly o monthly');
    }

    const dayOfWeek = frequency === 'weekly'
      ? (input.dayOfWeek ?? (current?.frecuencia === 'WEEKLY' ? current.diaSemana : null))
      : null;
    const dayOfMonth = frequency === 'monthly'
      ? (input.dayOfMonth ?? (current?.frecuencia === 'MONTHLY' ? current.diaMes : null))
      : null;
    if (frequency === 'weekly' && (dayOfWeek === null || dayOfWeek < 0 || dayOfWeek > 6)) {
      throw new BadRequestException('dayOfWeek debe estar entre 0 y 6');
    }
    if (frequency === 'monthly' && (dayOfMonth === null || dayOfMonth < 1 || dayOfMonth > 28)) {
      throw new BadRequestException('dayOfMonth debe estar entre 1 y 28');
    }

    const settings = {
      savedQueryId,
      nombre: reportTitle.trim(),
      frecuencia: dbFrequency(frequency),
      hora: time,
      diaSemana: dayOfWeek,
      diaMes: dayOfMonth,
      zonaHoraria: timezone,
      formato: dbFormat(format),
      destinatarios: [...new Set(recipients)],
      enviarCorreo: sendEmail,
    };
    this.validateCronConfig(settings);
    return settings;
  }

  private validateCronConfig(config: {
    frecuencia: ScheduleRecord['frecuencia'];
    hora: string;
    diaSemana: number | null;
    diaMes: number | null;
    zonaHoraria: string;
  }): void {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.hora)) {
      throw new BadRequestException('La hora debe usar el formato HH:mm');
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: config.zonaHoraria });
      this.cronExpression(config);
    } catch {
      throw new BadRequestException('La zona horaria o la configuración de frecuencia no es válida');
    }
  }

  private cronExpression(config: {
    frecuencia: ScheduleRecord['frecuencia'];
    hora: string;
    diaSemana: number | null;
    diaMes: number | null;
  }): string {
    const [hour, minute] = config.hora.split(':').map(Number);
    switch (config.frecuencia) {
      case 'DAILY':
        return `${minute} ${hour} * * *`;
      case 'WEEKLY':
        if (config.diaSemana === null || config.diaSemana < 0 || config.diaSemana > 6) {
          throw new BadRequestException('dayOfWeek debe estar entre 0 y 6');
        }
        return `${minute} ${hour} * * ${config.diaSemana}`;
      case 'MONTHLY':
        if (config.diaMes === null || config.diaMes < 1 || config.diaMes > 28) {
          throw new BadRequestException('dayOfMonth debe estar entre 1 y 28');
        }
        return `${minute} ${hour} ${config.diaMes} * *`;
    }
  }

  private isDueAt(schedule: ScheduleRecord, date: Date): boolean {
    try {
      const local = getDateParts(date, schedule.zonaHoraria);
      if (`${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}` !== schedule.hora) {
        return false;
      }
      switch (schedule.frecuencia) {
        case 'DAILY':
          return true;
        case 'WEEKLY':
          return new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay() === schedule.diaSemana;
        case 'MONTHLY':
          return local.day === schedule.diaMes;
      }
      return false;
    } catch {
      return false;
    }
  }

  private jobConfigKey(schedule: ScheduleRecord): string {
    return [
      schedule.frecuencia,
      schedule.hora,
      schedule.diaSemana ?? '',
      schedule.diaMes ?? '',
      schedule.zonaHoraria,
    ].join('|');
  }

  private registerJob(schedule: ScheduleRecord): void {
    const expression = this.cronExpression(schedule);
    const job = new CronJob(
      expression,
      () => this.runScheduled(schedule.id),
      null,
      false,
      schedule.zonaHoraria,
      null,
      false,
      null,
      false,
      true,
    );
    this.schedulerRegistry.addCronJob(this.jobName(schedule.id), job);
    job.start();
    this.registeredJobConfigs.set(schedule.id, this.jobConfigKey(schedule));
  }

  private async syncJob(schedule: ScheduleRecord): Promise<ScheduleRecord> {
    if (schedule.estado !== 'ACTIVE') {
      this.removeJob(schedule.id);
      return schedule;
    }
    if (this.registeredJobConfigs.get(schedule.id) === this.jobConfigKey(schedule)) return schedule;
    this.removeJob(schedule.id);
    try {
      this.registerJob(schedule);
      return schedule;
    } catch {
      this.removeJob(schedule.id);
      this.logger.error(`No se pudo registrar la programación ${schedule.id}`);
      const errored = await this.prisma.scheduledReport.update({
        where: { id: schedule.id },
        data: { estado: 'ERROR', lastError: 'No se pudo registrar la programación.' },
        include: SCHEDULE_INCLUDE,
      });
      await this.audit.record({
        eventType: 'SCHEDULED_REPORT_UPDATED',
        outcome: 'FAILURE',
        actorEmail: 'system@datanexus.local',
        workspaceId: schedule.workspaceId,
        targetType: 'SCHEDULED_REPORT',
        targetId: schedule.id,
        details: { status: 'ERROR' },
      });
      return errored;
    }
  }

  private removeJob(id: string): void {
    const name = this.jobName(id);
    const jobs = this.schedulerRegistry.getCronJobs();
    const job = jobs.get(name);
    if (job) {
      job.stop();
      this.schedulerRegistry.deleteCronJob(name);
    }
    this.registeredJobConfigs.delete(id);
  }

  private jobName(id: string): string {
    return `scheduled-report-${id}`;
  }

  private nextRunAt(schedule: ScheduleRecord): string | null {
    if (schedule.estado !== 'ACTIVE') return null;
    try {
      const job = new CronJob(
        this.cronExpression(schedule),
        () => undefined,
        null,
        false,
        schedule.zonaHoraria,
      );
      return job.nextDate().toJSDate().toISOString();
    } catch {
      return null;
    }
  }

  private toResponse(schedule: ScheduleRecord): ScheduledReportResponseDto {
    return {
      id: schedule.id,
      savedQueryId: schedule.savedQueryId,
      savedQueryName: schedule.savedQuery.nombre,
      reportTitle: schedule.nombre,
      frequency: dtoFrequency(schedule.frecuencia),
      time: schedule.hora,
      dayOfWeek: schedule.diaSemana,
      dayOfMonth: schedule.diaMes,
      timezone: schedule.zonaHoraria,
      cronExpression: this.cronExpression(schedule),
      nextRunAt: this.nextRunAt(schedule),
      format: dtoFormat(schedule.formato),
      recipients: schedule.destinatarios,
      sendEmail: schedule.enviarCorreo,
      status: schedule.estado,
      lastRunAt: schedule.lastRunAt,
      lastError: schedule.lastError,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    };
  }

  private toRunResponse(run: {
    id: string;
    trigger: 'SCHEDULED' | 'MANUAL';
    status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    scheduledFor: Date | null;
    startedAt: Date;
    finishedAt: Date | null;
    totalRows: number | null;
    error: string | null;
    downloadUrl: string | null;
    expiresAt: Date | null;
    messageId: string | null;
  }): ScheduledReportRunResponseDto {
    return {
      ...run,
      downloadUrl: run.expiresAt && run.expiresAt > new Date() ? run.downloadUrl : null,
    };
  }

  private async findSchedule(workspaceId: string, id: string): Promise<ScheduleRecord> {
    const schedule = await this.prisma.scheduledReport.findFirst({
      where: { id, workspaceId },
      include: SCHEDULE_INCLUDE,
    });
    if (!schedule) throw new NotFoundException('Programación no encontrada en el workspace');
    return schedule;
  }

  private async updateStatus(
    actor: AuthenticatedUser,
    current: ScheduleRecord,
    status: 'ACTIVE' | 'PAUSED',
    context: RequestAuditContext,
    newOwnerId?: string,
  ): Promise<ScheduleRecord> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const schedule = await tx.scheduledReport.update({
        where: { id: current.id },
        data: {
          estado: status,
          lastError: status === 'ACTIVE' ? null : current.lastError,
          ...(newOwnerId ? { createdById: newOwnerId } : {}),
        },
        include: SCHEDULE_INCLUDE,
      });
      await this.audit.record(
        {
          eventType: 'SCHEDULED_REPORT_UPDATED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'SCHEDULED_REPORT',
          targetId: current.id,
          details: {
            status,
            ...(newOwnerId && newOwnerId !== current.createdById
              ? { executionOwnerChangedTo: newOwnerId }
              : {}),
          },
          ...context,
        },
        tx,
      );
      return schedule;
    });
    return updated;
  }

  private async recordRunAudit(
    actor: AuthenticatedUser,
    schedule: ScheduleRecord,
    runId: string,
    trigger: 'SCHEDULED' | 'MANUAL',
    outcome: 'SUCCESS' | 'FAILURE',
    details: Record<string, unknown>,
    context: RequestAuditContext = {},
  ): Promise<void> {
    await this.audit.record({
      eventType: 'SCHEDULED_REPORT_RUN',
      outcome,
      actorUserId: actor.id === 'system' ? undefined : actor.id,
      actorEmail: actor.email,
      workspaceId: schedule.workspaceId,
      targetType: 'SCHEDULED_REPORT',
      targetId: schedule.id,
      details: { executionId: runId, trigger, ...details },
      ...context,
    });
  }

  private assertCanManage(actor: AuthenticatedUser): void {
    if (!hasPermission(actor.role, 'MANAGE_REPORTS')) {
      throw new ForbiddenException('Se requiere rol ADMIN u OPERADOR para gestionar reportes programados');
    }
  }
}
