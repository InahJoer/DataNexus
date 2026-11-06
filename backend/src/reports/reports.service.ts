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

const REPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  excel: REPORT_CONTENT_TYPES_BY_EXTENSION.xlsx,
  pdf: REPORT_CONTENT_TYPES_BY_EXTENSION.pdf,
  word: REPORT_CONTENT_TYPES_BY_EXTENSION.docx,
  json: REPORT_CONTENT_TYPES_BY_EXTENSION.json,
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
}

export interface ScheduledReportGenerationOptions {
  maskAsRole: UserRole;
  sendEmail: boolean;
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
    return this.generateReport(actor, dto, {
      maskAsRole: actor.role,
      sendEmail: true,
      recordAudit: true,
      keepFileWhenEmailFails: false,
    });
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
        writeTarget.writable.destroy(error instanceof Error ? error : new Error(String(error)));
      }
      await writeTarget.completed.catch(() => undefined);
      throw error;
    }

    const download = await this.reportStorage.createDownloadUrl(reportId, exportResult.filename);
    let messageId: string | undefined;
    let sentAt: string | undefined;
    let deliveryError: string | undefined;
    if (options.sendEmail) {
      const generatedAt = new Date().toLocaleString('es');
      const expiresAt = new Date(download.expiresAt).toLocaleString('es');
      const email = renderReportEmail({
        reportTitle: dto.reportTitle,
        customMessage: dto.customMessage ?? 'Se generó un nuevo informe consolidado de DataNexus.',
        filename: exportResult.filename,
        fileSizeBytes,
        fileSizeLabel: `${(fileSizeBytes / 1024).toFixed(2)} KB`,
        generatedAt,
        expiresAt,
        downloadUrl: download.url,
      });

      try {
        const emailResult = await this.mailService.sendReportEmail({
          to: dto.recipients,
          subject: `[DataNexus] ${dto.reportTitle}`,
          text: email.text,
          html: email.html,
        });
        if (emailResult.rejected.length > 0 || emailResult.accepted.length === 0) {
          if (!options.keepFileWhenEmailFails) {
            throw new Error('No se pudo entregar el reporte a todos los destinatarios');
          }
          deliveryError = 'El reporte se generó, pero falló la entrega por correo.';
          this.logger.error('No se pudo entregar un reporte programado a todos sus destinatarios');
        } else {
          messageId = emailResult.messageId;
          sentAt = new Date().toISOString();
        }
      } catch (error) {
        if (!options.keepFileWhenEmailFails) throw error;
        deliveryError ??= 'El reporte se generó, pero falló la entrega por correo.';
        this.logger.error('No se pudo enviar un reporte programado por correo');
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
    };
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
