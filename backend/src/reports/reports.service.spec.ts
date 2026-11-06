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
});
