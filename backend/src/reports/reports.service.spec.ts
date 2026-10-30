import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
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
      executeCrossJoinForExport: vi.fn().mockResolvedValue({
        buffer: Buffer.from('mock-excel-binary'),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'datanexus_export_2026.xlsx',
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

    service = new ReportsService(
      dataEngineService as unknown as DataEngineService,
      mailService as unknown as MailService,
      auditService as unknown as AuditService,
      prismaService as unknown as PrismaService,
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

    expect(dataEngineService.executeCrossJoinForExport).not.toHaveBeenCalled();
    expect(mailService.sendReportEmail).not.toHaveBeenCalled();
  });

  it('executes cross-join, sends email with attachment and records audit', async () => {
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

    expect(dataEngineService.executeCrossJoinForExport).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'excel' }),
      adminUser,
    );
    expect(mailService.sendReportEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['analista@corp.com'],
        subject: '[DataNexus] Reporte Financiero',
        attachments: [
          expect.objectContaining({
            filename: 'datanexus_export_2026.xlsx',
          }),
        ],
      }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'REPORT_GENERATED_AND_SENT',
        outcome: 'SUCCESS',
        actorUserId: 'admin-1',
      }),
    );
    expect(result.messageId).toBe('email-id-999');
    expect(result.fileSizeBytes).toBeGreaterThan(0);
  });
});
