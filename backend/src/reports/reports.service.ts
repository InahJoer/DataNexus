import {
  Injectable,
  Logger,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import type { LocalReportDownload, ReportStorageAdapter } from './storage/report-storage.interface.js';
import { REPORT_STORAGE_ADAPTER } from './storage/report-storage.interface.js';
import { DataEngineService } from '../data-engine/data-engine.service.js';
import { MailService } from '../mailer/mail.service.js';
import { renderReportEmail } from './templates/report-email.template.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
import { TriggerReportDto } from './dto/trigger-report.dto.js';
import type { ReportFormat } from '../data-engine/dto/cross-join.dto.js';
import { REPORT_CONTENT_TYPES_BY_EXTENSION } from './storage/report-storage.interface.js';

const REPORT_CONTENT_TYPES: Record<ReportFormat, string> = {
  excel: REPORT_CONTENT_TYPES_BY_EXTENSION.xlsx,
  pdf: REPORT_CONTENT_TYPES_BY_EXTENSION.pdf,
  word: REPORT_CONTENT_TYPES_BY_EXTENSION.docx,
};

export interface ReportExecutionResult {
  reportTitle: string;
  recipients: string[];
  format: ReportFormat;
  filename: string;
  totalRows: number;
  fileSizeBytes: number;
  downloadUrl: string;
  expiresAt: string;
  messageId: string;
  sentAt: string;
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
   * Tarea programada ejecutada automáticamente a la medianoche (CronJob).
   * Cumple con RF-22 y RF-23 (Issue #4).
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: 'daily-midnight-reports',
    timeZone: 'UTC',
  })
  async handleMidnightCron(): Promise<void> {
    this.logger.log('Iniciando ejecución programada diaria de reportes automáticos (Medianoche UTC)...');

    // Consultamos los workspaces activos
    const workspaces = await this.prisma.workspace.findMany({
      include: {
        conexiones: { take: 2 },
        users: { where: { role: 'ADMIN' }, take: 1 },
      },
    });

    for (const ws of workspaces) {
      if (ws.conexiones.length >= 2 && ws.users.length > 0) {
        const adminUser: AuthenticatedUser = {
          id: ws.users[0].id,
          email: ws.users[0].email,
          name: ws.users[0].name,
          role: 'ADMIN',
          workspaceId: ws.id,
        };

        const sqlConn = ws.conexiones.find(
          (c) => !['FIRESTORE', 'FIREBASE', 'MONGODB'].includes(c.tipoMotor.toUpperCase()),
        ) ?? ws.conexiones[0];
        const noSqlConn = ws.conexiones.find(
          (c) => ['FIRESTORE', 'FIREBASE', 'MONGODB'].includes(c.tipoMotor.toUpperCase()),
        ) ?? ws.conexiones[1];

        try {
          await this.triggerReport(adminUser, {
            reportTitle: `Reporte Diario Consolidado - ${ws.nombreEmpresa}`,
            recipients: [adminUser.email],
            format: 'excel',
            crossJoinParams: {
              conexionSqlId: sqlConn.id,
              conexionNoSqlId: noSqlConn.id,
              tablaSql: 'clientes',
              coleccionNoSql: 'pedidos',
              llaveSql: 'id',
              llaveNoSql: 'cliente_id',
              limit: 500,
              offset: 0,
            },
            customMessage: 'Reporte diario programado generado automáticamente a la medianoche.',
          });
        } catch (error) {
          this.logger.error(
            `Error al generar reporte programado para Workspace ${ws.nombreEmpresa}: ${String(error)}`,
          );
        }
      }
    }
  }

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

    this.logger.log(
      `Generando reporte '${dto.reportTitle}' para Workspace ${actor.workspaceId} en formato ${dto.format}`,
    );

    const reportId = randomUUID();
    const contentType = REPORT_CONTENT_TYPES[dto.format];
    const writeTarget = await this.reportStorage.createWriteTarget(reportId, contentType);

    let exportResult: Awaited<ReturnType<DataEngineService['executeCrossJoinToStream']>>;
    let fileSizeBytes: number;
    try {
      [exportResult, fileSizeBytes] = await Promise.all([
        this.dataEngineService.executeCrossJoinToStream(
          {
            ...dto.crossJoinParams,
            format: dto.format,
          },
          actor,
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
    const generatedAt = new Date().toLocaleString('es');
    const expiresAt = new Date(download.expiresAt).toLocaleString('es');
    const customMessage =
      dto.customMessage ?? 'Se generó un nuevo informe consolidado de DataNexus.';
    const email = renderReportEmail({
      reportTitle: dto.reportTitle,
      customMessage,
      filename: exportResult.filename,
      fileSizeBytes,
      fileSizeLabel: `${(fileSizeBytes / 1024).toFixed(2)} KB`,
      generatedAt,
      expiresAt,
      downloadUrl: download.url,
    });

    // El reporte se entrega mediante un enlace temporal; no se adjunta el archivo en memoria.
    const emailResult = await this.mailService.sendReportEmail({
      to: dto.recipients,
      subject: `[DataNexus] ${dto.reportTitle}`,
      text: email.text,
      html: email.html,
    });

    // 3. Auditoría de la acción
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

    return {
      reportTitle: dto.reportTitle,
      recipients: dto.recipients,
      format: dto.format,
      filename: exportResult.filename,
      totalRows: exportResult.totalRows,
      fileSizeBytes,
      downloadUrl: download.url,
      expiresAt: download.expiresAt,
      messageId: emailResult.messageId,
      sentAt: new Date().toISOString(),
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
