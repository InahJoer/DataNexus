import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspacesService } from './workspaces.service.js';
import { WorkspacesController } from './workspaces.controller.js';
import { REQUIRED_ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import type { UserRole } from '../auth/interfaces/user-role.js';

const actor = (role: UserRole, workspaceId = 'ws-1'): AuthenticatedUser => ({
  id: `${role.toLowerCase()}-1`,
  email: `${role.toLowerCase()}@acme.com`,
  name: role,
  role,
  workspaceId,
});

const workspaceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ws-1',
  nombreEmpresa: 'Acme',
  logoUrl: null,
  zonaHoraria: 'UTC',
  dominiosPermitidos: ['acme.com'],
  camposSensibles: ['cedula'],
  fechaCreacion: new Date('2026-01-01T00:00:00Z'),
  fechaActualizacion: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('WorkspacesService', () => {
  let prisma: any;
  let tx: any;
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: WorkspacesService;

  beforeEach(() => {
    tx = {
      workspace: {
        findUnique: vi.fn().mockResolvedValue(workspaceRow()),
        update: vi.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(workspaceRow({ ...data, fechaActualizacion: new Date('2026-02-01T00:00:00Z') })),
        ),
      },
    };
    prisma = {
      workspace: { findUnique: vi.fn().mockResolvedValue(workspaceRow()) },
      user: { groupBy: vi.fn().mockResolvedValue([]) },
      conexionDB: { groupBy: vi.fn().mockResolvedValue([]) },
      registroAuditoria: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback: (client: unknown) => unknown) => callback(tx)),
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new WorkspacesService(prisma as PrismaService, audit as unknown as AuditService);
  });

  describe('findMine', () => {
    it('busca siempre por el workspace del token', async () => {
      await service.findMine(actor('LECTOR', 'ws-del-token'));
      expect(prisma.workspace.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ws-del-token' } }),
      );
    });

    it('incluye la configuración para ADMIN', async () => {
      const result = await service.findMine(actor('ADMIN'));
      expect(result.configuracion).toEqual({ dominiosPermitidos: ['acme.com'], camposSensibles: ['cedula'] });
    });

    it.each(['OPERADOR', 'LECTOR', 'AUDITOR'] as const)('oculta la configuración a %s', async (role) => {
      const result = await service.findMine(actor(role));
      expect(result).not.toHaveProperty('configuracion');
      expect(result).not.toHaveProperty('dominiosPermitidos');
      expect(result).not.toHaveProperty('camposSensibles');
      expect(result.nombreEmpresa).toBe('Acme');
    });

    it('responde 404 si el workspace ya no existe', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(service.findMine(actor('ADMIN'))).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateMine', () => {
    it.each(['OPERADOR', 'LECTOR', 'AUDITOR'] as const)('rechaza a %s sin abrir transacción', async (role) => {
      await expect(service.updateMine(actor(role), { nombreEmpresa: 'Hack' })).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('exige al menos un campo', async () => {
      await expect(service.updateMine(actor('ADMIN'), {})).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('actualiza solo el workspace del token y audita antes/después en la misma transacción', async () => {
      const result = await service.updateMine(
        actor('ADMIN', 'ws-1'),
        { nombreEmpresa: 'Acme Analytics', zonaHoraria: 'America/Managua' },
        { ipAddress: '10.0.0.1', userAgent: 'vitest' },
      );

      expect(tx.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ws-1' },
          data: { nombreEmpresa: 'Acme Analytics', zonaHoraria: 'America/Managua' },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'WORKSPACE_UPDATED',
          outcome: 'SUCCESS',
          workspaceId: 'ws-1',
          targetType: 'WORKSPACE',
          targetId: 'ws-1',
          ipAddress: '10.0.0.1',
          details: {
            campos: ['nombreEmpresa', 'zonaHoraria'],
            cambios: {
              nombreEmpresa: { antes: 'Acme', despues: 'Acme Analytics' },
              zonaHoraria: { antes: 'UTC', despues: 'America/Managua' },
            },
          },
        }),
        tx,
      );
      expect(result.nombreEmpresa).toBe('Acme Analytics');
      expect(result.configuracion).toBeDefined();
    });

    it('normaliza dominios y campos sensibles antes de guardar', async () => {
      await service.updateMine(actor('ADMIN'), {
        dominiosPermitidos: ['@ACME.com', 'acme.com', 'Acme.com.ni'],
        camposSensibles: ['Salario', 'salario'],
      });
      expect(tx.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { dominiosPermitidos: ['acme.com', 'acme.com.ni'], camposSensibles: ['salario'] },
        }),
      );
    });

    it('rechaza dominios de correo personal con 400', async () => {
      await expect(
        service.updateMine(actor('ADMIN'), { dominiosPermitidos: ['gmail.com'] }),
      ).rejects.toThrow(/gmail\.com/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza nombres de campo inválidos con 400', async () => {
      await expect(
        service.updateMine(actor('ADMIN'), { camposSensibles: ['ok', 'mal campo'] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('logoUrl null elimina el logo', async () => {
      tx.workspace.findUnique.mockResolvedValue(workspaceRow({ logoUrl: 'https://cdn.acme.com/a.png' }));
      await service.updateMine(actor('ADMIN'), { logoUrl: null });
      expect(tx.workspace.update).toHaveBeenCalledWith(expect.objectContaining({ data: { logoUrl: null } }));
    });

    it('no escribe ni audita si nada cambia', async () => {
      const result = await service.updateMine(actor('ADMIN'), {
        nombreEmpresa: 'Acme',
        dominiosPermitidos: ['acme.com'],
      });
      expect(tx.workspace.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(result.nombreEmpresa).toBe('Acme');
    });

    it('responde 404 si el workspace ya no existe', async () => {
      tx.workspace.findUnique.mockResolvedValue(null);
      await expect(service.updateMine(actor('ADMIN'), { nombreEmpresa: 'Nuevo' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getStats', () => {
    it('cuenta miembros, conexiones y reportes solo del workspace del token', async () => {
      prisma.user.groupBy.mockResolvedValue([
        { role: 'ADMIN', _count: { _all: 1 } },
        { role: 'LECTOR', _count: { _all: 3 } },
      ]);
      prisma.conexionDB.groupBy.mockResolvedValue([{ tipoMotor: 'POSTGRESQL', _count: { _all: 2 } }]);
      prisma.registroAuditoria.count.mockResolvedValue(5);
      const last = new Date('2026-11-05T06:00:00Z');
      prisma.registroAuditoria.findFirst.mockResolvedValue({ createdAt: last });

      const stats = await service.getStats(actor('AUDITOR', 'ws-9'));

      expect(stats).toEqual({
        miembros: { total: 4, porRol: { ADMIN: 1, OPERADOR: 0, LECTOR: 3, AUDITOR: 0 } },
        conexiones: {
          total: 2,
          porMotor: { POSTGRESQL: 2, MYSQL: 0, SQLSERVER: 0, FIRESTORE: 0, MONGODB: 0 },
        },
        reportes: { enviados: 5, ultimoEnvio: last },
      });
      for (const call of [
        prisma.user.groupBy,
        prisma.conexionDB.groupBy,
        prisma.registroAuditoria.count,
        prisma.registroAuditoria.findFirst,
      ]) {
        expect(call.mock.calls[0][0].where).toMatchObject({ workspaceId: 'ws-9' });
      }
    });

    it('devuelve ceros en un workspace vacío', async () => {
      const stats = await service.getStats(actor('ADMIN'));
      expect(stats.miembros.total).toBe(0);
      expect(stats.conexiones.total).toBe(0);
      expect(stats.reportes).toEqual({ enviados: 0, ultimoEnvio: null });
    });
  });
});

describe('WorkspacesController (RBAC)', () => {
  const reflector = new Reflector();
  const rolesOf = (method: keyof WorkspacesController) =>
    reflector.get<UserRole[] | undefined>(REQUIRED_ROLES_KEY, WorkspacesController.prototype[method]);

  it('solo ADMIN puede modificar el workspace', () => {
    expect(rolesOf('updateMine')).toEqual(['ADMIN']);
  });

  it('cualquier rol autenticado puede consultar el workspace y sus estadísticas', () => {
    expect(rolesOf('findMine')).toBeUndefined();
    expect(rolesOf('getStats')).toBeUndefined();
  });
});
