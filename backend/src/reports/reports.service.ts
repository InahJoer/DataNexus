import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataEngineService } from '../data-engine/data-engine.service.js';
import { MailService } from '../mailer/mail.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { TriggerReportDto } from './dto/trigger-report.dto.js';

export interface ReportExecutionResult {
  reportTitle: string;
  recipients: string[];
  format: string;
  filename: string;
  fileSizeBytes: number;
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
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Se requiere rol ADMIN para automatizar y enviar reportes');
    }

    this.logger.log(
      `Generando reporte '${dto.reportTitle}' para Workspace ${actor.workspaceId} en formato ${dto.format}`,
    );

    // 1. Ejecución del Cross-Join y generación de Buffer en memoria
    const exportResult = await this.dataEngineService.executeCrossJoinForExport(
      {
        ...dto.crossJoinParams,
        format: dto.format,
      },
      actor,
    );

    // 2. Envío por correo con archivo adjunto
    const emailResult = await this.mailService.sendReportEmail({
      to: dto.recipients,
      subject: `[DataNexus] ${dto.reportTitle}`,
      text:
        dto.customMessage ??
        `Adjunto encontrará el archivo del reporte '${dto.reportTitle}' generado por DataNexus.`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #E0E0E0; border-radius: 8px;">
          <h2 style="color: #1F4E78; margin-top: 0;">${dto.reportTitle}</h2>
          <p>${dto.customMessage ?? 'Adjunto encontrará el informe consolidado correspondiente a la consulta de datos.'}</p>
          <div style="background-color: #F8F9FA; padding: 12px; border-left: 4px solid #1F4E78; margin: 15px 0;">
            <p style="margin: 0;"><strong>Archivo adjunto:</strong> ${exportResult.filename}</p>
            <p style="margin: 5px 0 0 0;"><strong>Tamaño:</strong> ${(exportResult.buffer.length / 1024).toFixed(2)} KB</p>
          </div>
          <p style="color: #777; font-size: 12px;">Generado automáticamente por DataNexus Platform.</p>
        </div>
      `,
      attachments: [
        {
          filename: exportResult.filename,
          content: exportResult.buffer,
          contentType: exportResult.contentType,
        },
      ],
    });

    // 3. Auditoría de la acción
    await this.auditService.record({
      eventType: 'REPORT_GENERATED_AND_SENT' as any,
      outcome: 'SUCCESS',
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'REPORT' as any,
      targetId: exportResult.filename,
      details: {
        title: dto.reportTitle,
        format: dto.format,
        recipientsCount: dto.recipients.length,
        fileSizeBytes: exportResult.buffer.length,
      },
    });

    return {
      reportTitle: dto.reportTitle,
      recipients: dto.recipients,
      format: dto.format,
      filename: exportResult.filename,
      fileSizeBytes: exportResult.buffer.length,
      messageId: emailResult.messageId,
      sentAt: new Date().toISOString(),
    };
  }
}
