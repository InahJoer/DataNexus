import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AuditService, MAX_AUDIT_EXPORT_ROWS } from './audit.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';

const auditor: AuthenticatedUser = {
  id: 'auditor-1',
  email: 'auditor@corp.com',
  name: 'Auditor',
  role: 'AUDITOR',
  workspaceId: 'workspace-1',
};

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'log-1',
  eventType: 'LOGIN_SUCCESS',
  outcome: 'SUCCESS',
  actorUserId: 'user-1',
  actorEmail: 'admin@corp.com',
  workspaceId: 'workspace-1',
  targetType: null,
  targetId: null,
  detailsJson: null,
  ipAddress: '192.0.2.1',
  userAgent: 'vitest',
  createdAt: new Date('2026-11-05T10:00:00.000Z'),
  ...overrides,
});

function insertedValues(executeRaw: ReturnType<typeof vi.fn>, call = 0): unknown[] {
  const [, ...values] = executeRaw.mock.calls[call] as [TemplateStringsArray, ...unknown[]];
  return values;
}

describe('AuditService.exportLogs', () => {
  let prisma: {
    $executeRaw: ReturnType<typeof vi.fn>;
    registroAuditoria: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  };
  let service: AuditService;

  beforeEach(() => {
    prisma = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      registroAuditoria: { findMany: vi.fn().mockResolvedValue([row()]), count: vi.fn() },
    };
    service = new AuditService(prisma as unknown as PrismaService);
  });

  it('rechaza a roles sin READ_AUDIT', async () => {
    await expect(
      service.exportLogs({ ...auditor, role: 'OPERADOR' }, { format: 'csv' }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.registroAuditoria.findMany).not.toHaveBeenCalled();
  });

  it('genera CSV con BOM, encabezados y filtros del workspace', async () => {
    const result = await service.exportLogs(auditor, {
      format: 'csv',
      tipoAccion: 'LOGIN_SUCCESS',
      fechaInicio: '2026-11-01T00:00:00.000Z',
    });
    const csv = result.buffer.toString('utf8');

    expect(result.contentType).toContain('text/csv');
    expect(result.filename).toMatch(/^datanexus_auditoria_.+\.csv$/);
    expect(csv.startsWith('﻿createdAt,eventType,outcome')).toBe(true);
    expect(csv).toContain('2026-11-05T10:00:00.000Z,LOGIN_SUCCESS,SUCCESS,admin@corp.com');
    expect(prisma.registroAuditoria.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: 'workspace-1',
          eventType: 'LOGIN_SUCCESS',
          createdAt: { gte: new Date('2026-11-01T00:00:00.000Z') },
        },
        take: MAX_AUDIT_EXPORT_ROWS + 1,
      }),
    );
  });

  it('escapa comillas y comas y neutraliza fórmulas de hoja de cálculo', async () => {
    prisma.registroAuditoria.findMany.mockResolvedValue([
      row({ userAgent: 'Mozilla, "test"', actorEmail: '=HYPERLINK("http://malo")' }),
    ]);
    const csv = (await service.exportLogs(auditor, { format: 'csv' })).buffer.toString('utf8');

    expect(csv).toContain('"Mozilla, ""test"""');
    expect(csv).toContain(`"'=HYPERLINK(""http://malo"")"`);
  });

  it('genera JSON y marca cuando el archivo se recorta al máximo', async () => {
    prisma.registroAuditoria.findMany.mockResolvedValue(
      Array.from({ length: MAX_AUDIT_EXPORT_ROWS + 1 }, (_, i) => row({ id: `log-${i}` })),
    );
    const result = await service.exportLogs(auditor, { format: 'json' });

    expect(result.contentType).toContain('application/json');
    expect(result.truncated).toBe(true);
    expect(JSON.parse(result.buffer.toString('utf8'))).toHaveLength(MAX_AUDIT_EXPORT_ROWS);
  });

  it('registra la exportación como AUDIT_LOG_EXPORTED con IP y formato', async () => {
    await service.exportLogs(auditor, { format: 'json', tipoAccion: 'EXPORT' }, {
      ipAddress: '198.51.100.7',
      userAgent: 'vitest',
    });

    const values = insertedValues(prisma.$executeRaw);
    expect(values).toContain('AUDIT_LOG_EXPORTED');
    expect(values).toContain('AUDIT_LOG');
    expect(values).toContain('198.51.100.7');
    expect(values).toContain('{"formato":"json","tipoAccion":"EXPORT","totalFilas":1}');
  });
});

describe('AuditService.record para accesos a datos', () => {
  it('guarda solo los metadatos permitidos de un Cross-Join', async () => {
    const prisma = { $executeRaw: vi.fn().mockResolvedValue(1) };
    const service = new AuditService(prisma as unknown as PrismaService);

    await service.record({
      eventType: 'EXECUTE_JOIN',
      outcome: 'SUCCESS',
      actorUserId: 'user-1',
      workspaceId: 'workspace-1',
      targetType: 'CROSS_JOIN',
      targetId: 'dbo.clientes x pedidos',
      details: {
        tablaSql: 'clientes',
        coleccionNoSql: 'pedidos',
        totalFilas: 42,
        enmascarado: true,
        filtrosSql: 1,
        valoresFiltro: ['juan@corp.com'],
        filas: [{ email: 'juan@corp.com' }],
      },
    });

    const values = insertedValues(prisma.$executeRaw);
    const details = values.find((value) => typeof value === 'string' && value.startsWith('{')) as string;
    expect(JSON.parse(details)).toEqual({
      tablaSql: 'clientes',
      coleccionNoSql: 'pedidos',
      totalFilas: 42,
      filtrosSql: 1,
      enmascarado: true,
    });
    expect(details).not.toContain('juan@corp.com');
    expect(values).toContain('dbo.clientes x pedidos');
  });
});
