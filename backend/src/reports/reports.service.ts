import {
  Injectable,
  Logger,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { LocalReportDownload, ReportStorageAdapter } from './storage/report-storage.interface.js';
import { REPORT_STORAGE_ADAPTER } from './storage/report-storage.interface.js';
import { DataEngineService } from '../data-engine/data-engine.service.js';
import type { ExportFormat } from '../data-engine/dto/cross-join.dto.js';
import { MailService } from '../mailer/mail.service.js';
import { renderReportEmail } from './templates/report-email.template.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission, type UserRole } from '../auth/interfaces/user-role.js';
import { TriggerReportDto } from './dto/trigger-report.dto.js';
import { REPORT_CONTENT_TYPES_BY_EXTENSION } from './storage/report-storage.interface.js';
import {
  RetriesExhaustedError,
  getReportRetryPolicy,
  retryWithBackoff,
  type RetryPolicy,
} from './report-retry.js';

const REPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  excel: REPORT_CONTENT_TYPES_BY_EXTENSION.xlsx,
  pdf: REPORT_CONTENT_TYPES_BY_EXTENSION.pdf,
  word: REPORT_CONTENT_TYPES_BY_EXTENSION.docx,
  json: REPORT_CONTENT_TYPES_BY_EXTENSION.json,
  csv: REPORT_CONTENT_TYPES_BY_EXTENSION.csv,
};

export interface ReportExecutionResult {
  reportTitle: string;
  recipients: string[];
  format: ExportFormat;
  filename: string;
  totalRows: number;
  fileSizeBytes: number;
  downloadUrl: string;
  expiresAt: string;
  messageId?: string;
  sentAt?: string;
  deliveryError?: string;
  /** Intentos de envío por correo (0 si no se envió). */
  deliveryAttempts: number;
  /** Registro del historial (issue #39); solo en reportes bajo demanda. */
  executionId?: string;
}

export interface ScheduledReportGenerationOptions {
  maskAsRole: UserRole;
  sendEmail: boolean;
}

/** Mensajes seguros para el historial: nunca el texto del driver o del servidor SMTP. */
export const SAFE_REPORT_ERRORS = {
  generation: 'No se pudo generar el reporte. Revise la consulta y las conexiones del workspace.',
  delivery: 'El reporte se generó, pero falló la entrega por correo.',
} as const;

/** Lease de un reporte bajo demanda: si el proceso cae, la ejecución se marca interrumpida. */
const ON_DEMAND_LEASE_MS = 5 * 60_000;
const ON_DEMAND_HEARTBEAT_MS = 60_000;

/** El archivo se generó pero el correo no salió tras los reintentos. */
class DeliveryFailedError extends Error {
  constructor(
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(SAFE_REPORT_ERRORS.delivery);
  }
}

class EmailRejectedError extends Error {
  constructor() {
    super('No se pudo entregar el reporte a todos los destinatarios');
  }
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly dataEngineService: DataEngineService,
    private readonly mailService: MailService,
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    @Inject(REPORT_STORAGE_ADAPTER)
    private readonly reportStorage: ReportStorageAdapter,
  ) {}

  /**
   * Ejecución y despacho de reportes bajo demanda o por disparador.
   */
  async triggerReport(
    actor: AuthenticatedUser,
    dto: TriggerReportDto,
  ): Promise<ReportExecutionResult> {
    if (!hasPermission(actor.role, 'MANAGE_REPORTS')) {
      throw new ForbiddenException('Se requiere rol ADMIN u OPERADOR para automatizar y enviar reportes');
    }

    // Cada envío bajo demanda queda en el historial (issue #39), también si falla.
    const execution = await this.prisma.reportExecution.create({
      data: {
        workspaceId: actor.workspaceId,
        trigger: 'ON_DEMAND',
        titulo: dto.reportTitle,
        formato: dto.format,
        actorUserId: actor.id,
        leaseExpiresAt: new Date(Date.now() + ON_DEMAND_LEASE_MS),
      },
      select: { id: true, startedAt: true },
    });
    const stopHeartbeat = this.startLeaseHeartbeat(execution.id);

    try {
      const result = await this.generateReport(actor, dto, {
        maskAsRole: actor.role,
        sendEmail: true,
        recordAudit: true,
        keepFileWhenEmailFails: false,
        // Petición síncrona: reintentos rápidos para no dejar al cliente esperando minutos.
        emailRetryPolicy: { ...this.retryPolicy(), baseDelayMs: Math.min(this.retryPolicy().baseDelayMs, 2_000) },
        executionId: execution.id,
      });
      const finishedAt = new Date();
      await this.prisma.reportExecution.update({
        where: { id: execution.id },
        data: {
          status: 'SUCCEEDED',
          finishedAt,
          leaseExpiresAt: null,
          durationMs: finishedAt.getTime() - execution.startedAt.getTime(),
          attempts: Math.max(1, result.deliveryAttempts),
          totalRows: result.totalRows,
          fileSizeBytes: result.fileSizeBytes,
          downloadUrl: result.downloadUrl,
          expiresAt: new Date(result.expiresAt),
          messageId: result.messageId ?? null,
        },
      });
      return { ...result, executionId: execution.id };
    } catch (error) {
      const finishedAt = new Date();
      const attempts = error instanceof DeliveryFailedError ? error.attempts : 1;
      await this.prisma.reportExecution
        .update({
          where: { id: execution.id },
          data: {
            status: 'FAILED',
            finishedAt,
            leaseExpiresAt: null,
            durationMs: finishedAt.getTime() - execution.startedAt.getTime(),
            attempts,
            error: error instanceof DeliveryFailedError ? SAFE_REPORT_ERRORS.delivery : SAFE_REPORT_ERRORS.generation,
          },
        })
        .catch(() => this.logger.error(`No se pudo registrar el fallo de la ejecución ${execution.id}`));
      throw error instanceof DeliveryFailedError ? error.cause : error;
    } finally {
      stopHeartbeat();
    }
  }

  async triggerScheduledReport(
    actor: AuthenticatedUser,
    dto: TriggerReportDto,
    options: ScheduledReportGenerationOptions,
  ): Promise<ReportExecutionResult> {
    return this.generateReport(actor, dto, {
      ...options,
      recordAudit: false,
      keepFileWhenEmailFails: true,
    });
  }

  private async generateReport(
    actor: AuthenticatedUser,
    dto: TriggerReportDto,
    options: ScheduledReportGenerationOptions & {
      recordAudit: boolean;
      keepFileWhenEmailFails: boolean;
      emailRetryPolicy?: RetryPolicy;
      executionId?: string;
    },
  ): Promise<ReportExecutionResult> {
    if (!hasPermission(actor.role, 'MANAGE_REPORTS')) {
      throw new ForbiddenException('Se requiere rol ADMIN u OPERADOR para automatizar y enviar reportes');
    }

    this.logger.log(
      `Generando reporte '${dto.reportTitle}' para Workspace ${actor.workspaceId} en formato ${dto.format}`,
    );

    const reportId = randomUUID();
    const contentType = REPORT_CONTENT_TYPES[dto.format];
    const writeTarget = await this.reportStorage.createWriteTarget(reportId, contentType);
    const executionActor = options.maskAsRole === actor.role ? actor : { ...actor, role: options.maskAsRole };

    let exportResult: Awaited<ReturnType<DataEngineService['executeCrossJoinToStream']>>;
    let fileSizeBytes: number;
    try {
      [exportResult, fileSizeBytes] = await Promise.all([
        this.dataEngineService.executeCrossJoinToStream(
          {
            ...dto.crossJoinParams,
            format: dto.format,
          },
          executionActor,
          writeTarget.writable,
        ),
        writeTarget.completed,
      ]);
    } catch (error) {
      if (!writeTarget.writable.destroyed) {
        writeTarget.writable.destroy();
      }
      await writeTarget.completed.catch(() => undefined);
      throw error;
    }

    const download = await this.reportStorage.createDownloadUrl(reportId, exportResult.filename);
    let messageId: string | undefined;
    let sentAt: string | undefined;
    let deliveryError: string | undefined;
    let deliveryAttempts = 0;
    if (options.sendEmail) {
      const email = renderReportEmail({
        reportTitle: dto.reportTitle,
        customMessage: dto.customMessage ?? 'Se generó un nuevo informe consolidado de DataNexus.',
        filename: exportResult.filename,
        fileSizeBytes,
        fileSizeLabel: `${(fileSizeBytes / 1024).toFixed(2)} KB`,
        generatedAt: new Date().toLocaleString('es'),
        expiresAt: new Date(download.expiresAt).toLocaleString('es'),
        downloadUrl: download.url,
      });

      try {
        // Reintenta solo el envío: el archivo ya está generado y almacenado.
        const sent = await retryWithBackoff(
          async () => {
            const emailResult = await this.mailService.sendReportEmail({
              to: dto.recipients,
              subject: email.subject,
              text: email.text,
              html: email.html,
            });
            if (emailResult.rejected.length > 0 || emailResult.accepted.length === 0) {
              throw new EmailRejectedError();
            }
            return emailResult;
          },
          {
            policy: options.emailRetryPolicy ?? this.retryPolicy(),
            onRetry: (nextAttempt) =>
              this.logger.warn(`Reintentando el envío del reporte '${dto.reportTitle}' (intento ${nextAttempt})`),
            sleep: this.sleep,
          },
        );
        deliveryAttempts = sent.attempts;
        messageId = sent.value.messageId;
        sentAt = new Date().toISOString();
      } catch (error) {
        const exhausted = error instanceof RetriesExhaustedError ? error : new RetriesExhaustedError(1, error);
        deliveryAttempts = exhausted.attempts;
        if (!options.keepFileWhenEmailFails) {
          throw new DeliveryFailedError(exhausted.attempts, exhausted.lastError);
        }
        deliveryError = SAFE_REPORT_ERRORS.delivery;
        this.logger.error(`No se pudo enviar el reporte '${dto.reportTitle}' tras ${exhausted.attempts} intento(s)`);
      }
    }

    if (options.recordAudit) {
      await this.auditService.record({
        eventType: 'REPORT_GENERATED_AND_SENT',
        outcome: 'SUCCESS',
        actorUserId: actor.id,
        actorEmail: actor.email,
        workspaceId: actor.workspaceId,
        targetType: 'REPORT',
        targetId: reportId,
        details: {
          title: dto.reportTitle,
          format: dto.format,
          recipientsCount: dto.recipients.length,
          filename: exportResult.filename,
          totalRows: exportResult.totalRows,
          fileSizeBytes,
          ...(options.executionId ? { executionId: options.executionId } : {}),
        },
      });
    }

    return {
      reportTitle: dto.reportTitle,
      recipients: dto.recipients,
      format: dto.format,
      filename: exportResult.filename,
      totalRows: exportResult.totalRows,
      fileSizeBytes,
      downloadUrl: download.url,
      expiresAt: download.expiresAt,
      ...(messageId ? { messageId } : {}),
      ...(sentAt ? { sentAt } : {}),
      ...(deliveryError ? { deliveryError } : {}),
      deliveryAttempts,
    };
  }

  /** Inyectable en tests para no esperar los backoffs reales. */
  sleep?: (ms: number) => Promise<void>;

  private retryPolicy(): RetryPolicy {
    return getReportRetryPolicy();
  }

  private startLeaseHeartbeat(executionId: string): () => void {
    const timer = setInterval(() => {
      void this.prisma.reportExecution
        .updateMany({
          where: { id: executionId, status: 'RUNNING' },
          data: { leaseExpiresAt: new Date(Date.now() + ON_DEMAND_LEASE_MS) },
        })
        .catch(() => this.logger.error(`No se pudo renovar la ejecución ${executionId}`));
    }, ON_DEMAND_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async openLocalDownload(
    id: string,
    filename: string,
    expires: string,
    signature: string,
  ): Promise<LocalReportDownload> {
    return this.reportStorage.openLocalDownload(id, filename, expires, signature);
  }
}
