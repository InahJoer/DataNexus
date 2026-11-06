import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { ReportsService } from './reports.service.js';
import type { DataEngineService } from '../data-engine/data-engine.service.js';
import type { MailService } from '../mailer/mail.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';

describe('ReportsService', () => {
  let service: ReportsService;
  let dataEngineService: any;
  let mailService: any;
  let auditService: any;
  let prismaService: any;
  let reportStorage: any;

  const adminUser: AuthenticatedUser = {
    id: 'admin-1',
    email: 'admin@corp.com',
    name: 'Admin',
    role: 'ADMIN',
    workspaceId: 'ws-1',
  };

  const lectorUser: AuthenticatedUser = {
    id: 'lector-1',
    email: 'lector@corp.com',
    name: 'Lector',
    role: 'LECTOR',
    workspaceId: 'ws-1',
  };

  beforeEach(() => {
    dataEngineService = {
      executeCrossJoinToStream: vi.fn().mockResolvedValue({
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'datanexus_export_2026.xlsx',
        totalRows: 12,
      }),
    };

    mailService = {
      sendReportEmail: vi.fn().mockResolvedValue({
        messageId: 'email-id-999',
        accepted: ['analista@corp.com'],
        rejected: [],
      }),
    };

    auditService = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    prismaService = {
      workspace: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      reportExecution: {
        create: vi.fn().mockResolvedValue({ id: 'exec-1', startedAt: new Date(Date.now() - 1500) }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    reportStorage = {
      createWriteTarget: vi.fn().mockResolvedValue({
        writable: new PassThrough(),
        completed: Promise.resolve(Buffer.byteLength('mock-excel-binary')),
      }),
      createDownloadUrl: vi.fn().mockResolvedValue({
        url: 'http://localhost:3001/reports/download/mock',
        expiresAt: '2026-11-06T12:00:00.000Z',
      }),
      openLocalDownload: vi.fn(),
    };

    service = new ReportsService(
      dataEngineService as unknown as DataEngineService,
      mailService as unknown as MailService,
      auditService as unknown as AuditService,
      prismaService as unknown as PrismaService,
      reportStorage,
    );
    // Sin esperas reales entre reintentos.
    service.sleep = async () => undefined;
  });

  it('rejects triggerReport if actor is not ADMIN', async () => {
    await expect(
      service.triggerReport(lectorUser, {
        reportTitle: 'Test',
        recipients: ['analyst@corp.com'],
        format: 'excel',
        crossJoinParams: {} as any,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(dataEngineService.executeCrossJoinToStream).not.toHaveBeenCalled();
    expect(mailService.sendReportEmail).not.toHaveBeenCalled();
  });

  it('streams the report, sends a secure download link and records audit', async () => {
    const result = await service.triggerReport(adminUser, {
      reportTitle: 'Reporte Financiero',
      recipients: ['analista@corp.com'],
      format: 'excel',
      crossJoinParams: {
        conexionSqlId: 'sql-1',
        conexionNoSqlId: 'nosql-1',
        tablaSql: 'clientes',
        coleccionNoSql: 'pedidos',
        llaveSql: 'id',
        llaveNoSql: 'cliente_id',
      },
    });

    expect(dataEngineService.executeCrossJoinToStream).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'excel' }),
      adminUser,
      expect.any(PassThrough),
    );
    expect(mailService.sendReportEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['analista@corp.com'],
        subject: '[DataNexus] Reporte Financiero',
        html: expect.stringContaining('http://localhost:3001/reports/download/mock'),
      }),
    );
    expect(mailService.sendReportEmail.mock.calls[0][0].attachments).toBeUndefined();
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'REPORT_GENERATED_AND_SENT',
        outcome: 'SUCCESS',
        actorUserId: 'admin-1',
      }),
    );
    expect(result.messageId).toBe('email-id-999');
    expect(result.fileSizeBytes).toBeGreaterThan(0);
    expect(result.totalRows).toBe(12);
    expect(result.downloadUrl).toBe('http://localhost:3001/reports/download/mock');
  });
  it('genera reportes en Word con el tipo de contenido de .docx (RF-21)', async () => {
    dataEngineService.executeCrossJoinToStream.mockResolvedValue({
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'datanexus_export_2026-11-06T18-30-00-000Z.docx',
      totalRows: 3,
    });

    const result = await service.triggerReport(adminUser, {
      reportTitle: 'Reporte en Word',
      recipients: ['analista@corp.com'],
      format: 'word',
      crossJoinParams: {
        conexionSqlId: 'sql-1',
        conexionNoSqlId: 'nosql-1',
        tablaSql: 'clientes',
        coleccionNoSql: 'pedidos',
        llaveSql: 'id',
        llaveNoSql: 'cliente_id',
      },
    });

    expect(reportStorage.createWriteTarget).toHaveBeenCalledWith(
      expect.any(String),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(dataEngineService.executeCrossJoinToStream).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'word' }),
      adminUser,
      expect.any(PassThrough),
    );
    expect(result).toMatchObject({ format: 'word', filename: 'datanexus_export_2026-11-06T18-30-00-000Z.docx' });
  });

  describe('historial de ejecuciones bajo demanda (issue #39)', () => {
    const dto = {
      reportTitle: 'Ventas del día',
      recipients: ['analista@corp.com'],
      format: 'pdf' as const,
      crossJoinParams: {
        conexionSqlId: 'sql-1',
        conexionNoSqlId: 'nosql-1',
        tablaSql: 'clientes',
        coleccionNoSql: 'pedidos',
        llaveSql: 'id',
        llaveNoSql: 'cliente_id',
      },
    };

    it('registra la ejecución con estado, duración, tamaño, filas y messageId', async () => {
      const result = await service.triggerReport(adminUser, dto);

      expect(prismaService.reportExecution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 'ws-1',
          trigger: 'ON_DEMAND',
          titulo: 'Ventas del día',
          formato: 'pdf',
          actorUserId: 'admin-1',
        }),
        select: { id: true, startedAt: true },
      });
      const update = prismaService.reportExecution.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'exec-1' });
      expect(update.data).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 1,
        totalRows: 12,
        fileSizeBytes: Buffer.byteLength('mock-excel-binary'),
        messageId: 'email-id-999',
        leaseExpiresAt: null,
      });
      expect(update.data.durationMs).toBeGreaterThanOrEqual(1500);
      expect(result.executionId).toBe('exec-1');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ executionId: 'exec-1' }) }),
      );
    });

    it('reintenta el envío del correo sin volver a generar el archivo', async () => {
      mailService.sendReportEmail
        .mockRejectedValueOnce(new Error('SMTP 421'))
        .mockResolvedValueOnce({ messageId: 'm2', accepted: [], rejected: ['analista@corp.com'] })
        .mockResolvedValueOnce({ messageId: 'm3', accepted: ['analista@corp.com'], rejected: [] });

      const result = await service.triggerReport(adminUser, dto);

      expect(mailService.sendReportEmail).toHaveBeenCalledTimes(3);
      expect(dataEngineService.executeCrossJoinToStream).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ messageId: 'm3', deliveryAttempts: 3 });
      expect(prismaService.reportExecution.update.mock.calls[0][0].data).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 3,
        messageId: 'm3',
      });
    });

    it('registra el fallo de entrega tras agotar los reintentos y devuelve el error original', async () => {
      const smtpError = new Error('SMTP caído: 10.0.0.5:587');
      mailService.sendReportEmail.mockRejectedValue(smtpError);

      await expect(service.triggerReport(adminUser, dto)).rejects.toBe(smtpError);

      expect(mailService.sendReportEmail).toHaveBeenCalledTimes(3);
      const update = prismaService.reportExecution.update.mock.calls[0][0];
      expect(update.data).toMatchObject({
        status: 'FAILED',
        attempts: 3,
        error: 'El reporte se generó, pero falló la entrega por correo.',
      });
      // El mensaje guardado nunca incluye el detalle del servidor SMTP.
      expect(JSON.stringify(update.data)).not.toContain('10.0.0.5');
    });

    it('registra el fallo de generación con un mensaje seguro', async () => {
      dataEngineService.executeCrossJoinToStream.mockRejectedValue(new Error('password=secreta en el driver'));

      await expect(service.triggerReport(adminUser, dto)).rejects.toThrow('password=secreta');

      const update = prismaService.reportExecution.update.mock.calls[0][0];
      expect(update.data).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        error: 'No se pudo generar el reporte. Revise la consulta y las conexiones del workspace.',
      });
      expect(JSON.stringify(update.data)).not.toContain('secreta');
      expect(mailService.sendReportEmail).not.toHaveBeenCalled();
    });

    it('no registra nada si el rol no puede generar reportes', async () => {
      await expect(service.triggerReport(lectorUser, dto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prismaService.reportExecution.create).not.toHaveBeenCalled();
    });
  });
});
