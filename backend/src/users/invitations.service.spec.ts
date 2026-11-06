import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import bcrypt from 'bcrypt';
import {
  DEFAULT_INVITATION_TTL_HOURS,
  INVALID_INVITATION_MESSAGE,
  InvitationsService,
  hashInvitationToken,
} from './invitations.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { MailService } from '../mailer/mail.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import type { UserRole } from '../auth/interfaces/user-role.js';

const HOUR = 3_600_000;

const actor = (role: UserRole = 'ADMIN'): AuthenticatedUser => ({
  id: 'admin-1',
  email: 'admin@acme.com',
  name: 'Ana Admin',
  role,
  workspaceId: 'ws-1',
});

const invitationRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  email: 'nuevo@acme.com',
  name: 'Nuevo',
  role: 'LECTOR',
  status: 'PENDIENTE',
  expiresAt: new Date(Date.now() + 10 * HOUR),
  createdAt: new Date('2026-11-01T00:00:00Z'),
  acceptedAt: null,
  revokedAt: null,
  workspaceId: 'ws-1',
  invitedBy: { id: 'admin-1', name: 'Ana Admin', email: 'admin@acme.com' },
  ...overrides,
});

describe('InvitationsService', () => {
  let prisma: any;
  let tx: any;
  let audit: { record: ReturnType<typeof vi.fn> };
  let mail: { sendMail: ReturnType<typeof vi.fn> };
  let config: Record<string, string | undefined>;
  let service: InvitationsService;

  beforeEach(() => {
    tx = {
      invitation: {
        create: vi.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve(invitationRow(data))),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue(invitationRow()),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'user-new', email: data.email, workspaceId: data.workspaceId, role: data.role }),
        ),
      },
    };
    prisma = {
      workspace: {
        findUnique: vi.fn().mockResolvedValue({ nombreEmpresa: 'Acme S.A.', dominiosPermitidos: [] }),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      invitation: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
      },
      $transaction: vi.fn((callback: (client: unknown) => unknown) => callback(tx)),
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    mail = { sendMail: vi.fn().mockResolvedValue({ messageId: 'm-1' }) };
    config = { FRONTEND_URL: 'https://app.acme.com/' };
    service = new InvitationsService(
      prisma as PrismaService,
      audit as unknown as AuditService,
      mail as unknown as MailService,
      { get: (key: string) => config[key] } as unknown as ConfigService,
    );
  });

  describe('invite', () => {
    const dto = { email: 'nuevo@acme.com', name: 'Nuevo', role: 'LECTOR' as const };

    it.each(['OPERADOR', 'LECTOR', 'AUDITOR'] as const)('rechaza a %s', async (role) => {
      await expect(service.invite(actor(role), dto)).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('guarda solo el hash del token, audita y envía el enlace por correo', async () => {
      const before = Date.now();
      const result = await service.invite(actor(), dto, { ipAddress: '10.0.0.1' });

      const data = tx.invitation.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ email: 'nuevo@acme.com', role: 'LECTOR', workspaceId: 'ws-1', invitedById: 'admin-1' });
      expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      const ttl = data.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThanOrEqual(DEFAULT_INVITATION_TTL_HOURS * HOUR - 1000);
      expect(ttl).toBeLessThanOrEqual(DEFAULT_INVITATION_TTL_HOURS * HOUR + 1000);

      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.to).toBe('nuevo@acme.com');
      const token = /accept-invite\?token=([A-Za-z0-9_-]+)/.exec(sent.text)?.[1] ?? '';
      expect(sent.text).toContain('https://app.acme.com/accept-invite?token=');
      expect(hashInvitationToken(token)).toBe(data.tokenHash);
      expect(sent.text).toContain('Acme S.A.');
      expect(sent.text).toContain('Lector');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'USER_INVITED',
          targetType: 'INVITATION',
          ipAddress: '10.0.0.1',
          details: expect.objectContaining({ email: 'nuevo@acme.com', role: 'LECTOR' }),
        }),
        tx,
      );
      expect(result).toMatchObject({ id: 'inv-1', estado: 'PENDIENTE', correoEnviado: true });
      expect(result).not.toHaveProperty('tokenHash');
      expect(result).not.toHaveProperty('workspaceId');
    });

    it('usa INVITATION_TTL_HOURS cuando está configurado', async () => {
      config.INVITATION_TTL_HOURS = '24';
      const before = Date.now();
      await service.invite(actor(), dto);
      const ttl = tx.invitation.create.mock.calls[0][0].data.expiresAt.getTime() - before;
      expect(Math.round(ttl / HOUR)).toBe(24);
    });

    it('respeta los dominios permitidos del workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ nombreEmpresa: 'Acme', dominiosPermitidos: ['acme.com'] });
      await expect(service.invite(actor(), { ...dto, email: 'x@otra.com' })).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza correos ya registrados (409)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      await expect(service.invite(actor(), dto)).rejects.toThrow(ConflictException);
    });

    it('rechaza una segunda invitación pendiente para el mismo correo (409)', async () => {
      prisma.invitation.findFirst.mockResolvedValue({ id: 'inv-0' });
      await expect(service.invite(actor(), dto)).rejects.toThrow(/Reenvíala o revócala/);
      expect(prisma.invitation.findFirst.mock.calls[0][0].where).toMatchObject({
        workspaceId: 'ws-1',
        email: 'nuevo@acme.com',
        status: 'PENDIENTE',
      });
    });

    it('si el correo falla conserva la invitación y lo indica', async () => {
      mail.sendMail.mockRejectedValue(new Error('SMTP caído'));
      const result = await service.invite(actor(), dto);
      expect(result.correoEnviado).toBe(false);
      expect(tx.invitation.create).toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('marca como EXPIRADA una pendiente vencida y filtra por workspace', async () => {
      prisma.invitation.findMany.mockResolvedValue([
        invitationRow({ id: 'a' }),
        invitationRow({ id: 'b', expiresAt: new Date(Date.now() - HOUR) }),
        invitationRow({ id: 'c', status: 'REVOCADA' }),
      ]);
      const result = await service.list(actor());
      expect(result.map((i) => i.estado)).toEqual(['PENDIENTE', 'EXPIRADA', 'REVOCADA']);
      expect(prisma.invitation.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 'ws-1' });
    });

    it('traduce el filtro EXPIRADA a pendientes vencidas', async () => {
      await service.list(actor(), 'EXPIRADA');
      expect(prisma.invitation.findMany.mock.calls[0][0].where).toMatchObject({
        workspaceId: 'ws-1',
        status: 'PENDIENTE',
        expiresAt: { lte: expect.any(Date) },
      });
    });

    it('rechaza roles sin MANAGE_MEMBERS', async () => {
      await expect(service.list(actor('AUDITOR'))).rejects.toThrow(ForbiddenException);
    });
  });

  describe('resend', () => {
    it('rota el token, renueva el vencimiento y envía el nuevo enlace', async () => {
      prisma.invitation.findFirst.mockResolvedValue(invitationRow({ expiresAt: new Date(Date.now() - HOUR) }));
      const result = await service.resend(actor(), 'inv-1');

      const update = tx.invitation.updateMany.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'inv-1', status: 'PENDIENTE' });
      expect(update.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(update.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const token = /token=([A-Za-z0-9_-]+)/.exec(mail.sendMail.mock.calls[0][0].text)?.[1] ?? '';
      expect(hashInvitationToken(token)).toBe(update.data.tokenHash);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'INVITATION_RESENT' }), tx);
      expect(result.correoEnviado).toBe(true);
    });

    it('busca la invitación solo en el workspace del actor (404 si es ajena)', async () => {
      prisma.invitation.findFirst.mockResolvedValue(null);
      await expect(service.resend(actor(), 'inv-ajena')).rejects.toThrow(NotFoundException);
      expect(prisma.invitation.findFirst.mock.calls[0][0].where).toEqual({ id: 'inv-ajena', workspaceId: 'ws-1' });
    });

    it.each(['ACEPTADA', 'REVOCADA'])('no reenvía una invitación %s', async (status) => {
      prisma.invitation.findFirst.mockResolvedValue(invitationRow({ status }));
      await expect(service.resend(actor(), 'inv-1')).rejects.toThrow(ConflictException);
      expect(mail.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('revoca una pendiente de forma atómica y la audita', async () => {
      prisma.invitation.findFirst.mockResolvedValue(invitationRow());
      tx.invitation.findUniqueOrThrow.mockResolvedValue(invitationRow({ status: 'REVOCADA', revokedAt: new Date() }));

      const result = await service.revoke(actor(), 'inv-1');

      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', status: 'PENDIENTE' },
        data: { status: 'REVOCADA', revokedAt: expect.any(Date) },
      });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'INVITATION_REVOKED' }), tx);
      expect(result.estado).toBe('REVOCADA');
    });

    it('responde 409 si otra petición la cambió a la vez', async () => {
      prisma.invitation.findFirst.mockResolvedValue(invitationRow());
      tx.invitation.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.revoke(actor(), 'inv-1')).rejects.toThrow(ConflictException);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('devuelve datos públicos de una invitación vigente', async () => {
      prisma.invitation.findUnique.mockResolvedValue({
        ...invitationRow(),
        workspace: { nombreEmpresa: 'Acme S.A.' },
      });
      await expect(service.preview('t'.repeat(43))).resolves.toEqual({
        email: 'nuevo@acme.com',
        name: 'Nuevo',
        role: 'LECTOR',
        nombreEmpresa: 'Acme S.A.',
        expiresAt: expect.any(Date),
      });
      expect(prisma.invitation.findUnique.mock.calls[0][0].where).toEqual({ tokenHash: hashInvitationToken('t'.repeat(43)) });
    });

    it.each([
      ['inexistente', null],
      ['expirada', { ...invitationRow({ expiresAt: new Date(Date.now() - 1000) }), workspace: { nombreEmpresa: 'A' } }],
      ['aceptada', { ...invitationRow({ status: 'ACEPTADA' }), workspace: { nombreEmpresa: 'A' } }],
    ])('rechaza una invitación %s con el mismo mensaje', async (_label, row) => {
      prisma.invitation.findUnique.mockResolvedValue(row);
      await expect(service.preview('t'.repeat(43))).rejects.toThrow(INVALID_INVITATION_MESSAGE);
    });
  });

  describe('accept', () => {
    const token = 'x'.repeat(43);

    it('consume el token y crea el usuario con el rol de la invitación y su contraseña', async () => {
      tx.invitation.findUnique.mockResolvedValue(invitationRow());

      await expect(service.accept({ token, password: 'MiClave#2026dn' }, { ipAddress: '1.2.3.4' })).resolves.toEqual({
        message: expect.stringContaining('activada'),
      });

      expect(tx.invitation.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashInvitationToken(token) } });
      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', status: 'PENDIENTE', expiresAt: { gt: expect.any(Date) } },
        data: { status: 'ACEPTADA', acceptedAt: expect.any(Date) },
      });
      const data = tx.user.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ email: 'nuevo@acme.com', name: 'Nuevo', role: 'LECTOR', workspaceId: 'ws-1' });
      expect(await bcrypt.compare('MiClave#2026dn', data.password)).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'INVITATION_ACCEPTED', outcome: 'SUCCESS', actorUserId: 'user-new' }),
        tx,
      );
    });

    it('permite elegir otro nombre al aceptar', async () => {
      tx.invitation.findUnique.mockResolvedValue(invitationRow());
      await service.accept({ token, password: 'MiClave#2026dn', name: 'María López' });
      expect(tx.user.create.mock.calls[0][0].data.name).toBe('María López');
    });

    it.each([
      ['inexistente', null],
      ['expirada', invitationRow({ expiresAt: new Date(Date.now() - 1000) })],
      ['revocada', invitationRow({ status: 'REVOCADA' })],
      ['ya aceptada', invitationRow({ status: 'ACEPTADA' })],
    ])('rechaza una invitación %s, no crea usuario y audita el fallo', async (_label, row) => {
      tx.invitation.findUnique.mockResolvedValue(row);

      await expect(service.accept({ token, password: 'MiClave#2026dn' })).rejects.toThrow(INVALID_INVITATION_MESSAGE);

      expect(tx.user.create).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'INVITATION_ACCEPTED', outcome: 'FAILURE' }),
      );
    });

    it('si dos peticiones usan el enlace a la vez, solo una crea la cuenta', async () => {
      tx.invitation.findUnique.mockResolvedValue(invitationRow());
      tx.invitation.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.accept({ token, password: 'MiClave#2026dn' })).rejects.toThrow(BadRequestException);
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it('responde 409 si el correo ya tiene cuenta (y la transacción revierte el consumo)', async () => {
      tx.invitation.findUnique.mockResolvedValue(invitationRow());
      tx.user.findUnique.mockResolvedValue({ id: 'u-existente' });
      await expect(service.accept({ token, password: 'MiClave#2026dn' })).rejects.toThrow(ConflictException);
      expect(tx.user.create).not.toHaveBeenCalled();
    });
  });
});
