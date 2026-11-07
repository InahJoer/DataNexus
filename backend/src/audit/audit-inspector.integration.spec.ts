import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';
import { eventTypesWithImpact, impactOf } from './audit-impact.js';
import { AUDIT_EVENT_TYPES } from './audit.types.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';

describe('Impacto de los eventos de auditoría (#66)', () => {
  it('clasifica cada tipo de evento en un único nivel', () => {
    expect(impactOf('LOGIN_SUCCESS')).toBe('BAJO');
    expect(impactOf('EXECUTE_JOIN')).toBe('MEDIO');
    expect(impactOf('CONNECTION_CREATED')).toBe('ALTO');
    expect(impactOf('USER_ROLE_CHANGED')).toBe('ALTO');
    const all = [...eventTypesWithImpact('BAJO'), ...eventTypesWithImpact('MEDIO'), ...eventTypesWithImpact('ALTO')];
    expect(all.sort()).toEqual([...AUDIT_EVENT_TYPES].sort());
  });
});

/** Inspector, filtros y métricas de la bitácora contra PostgreSQL real. */
describe.skipIf(!process.env.DATABASE_URL)('Bitácora: inspector, filtros y métricas (#66)', () => {
  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const marker = `bitacora${Date.now()}`;
  let auditor: AuthenticatedUser;
  let otherWorkspace = '';

  beforeAll(async () => {
    await prisma.$connect();
    const ws = await prisma.workspace.create({ data: { nombreEmpresa: marker } });
    const other = await prisma.workspace.create({ data: { nombreEmpresa: `${marker}-otro` } });
    otherWorkspace = other.id;
    auditor = { id: 'aud', email: `auditor@${marker}.io`, name: 'Auditor', role: 'AUDITOR', workspaceId: ws.id };
    const record = (eventType: 'LOGIN_SUCCESS' | 'CONNECTION_CREATED' | 'EXECUTE_JOIN' | 'LOGIN_FAILURE', email: string, ip: string, outcome: 'SUCCESS' | 'FAILURE' = 'SUCCESS', workspaceId = ws.id) =>
      audit.record({ eventType, outcome, actorUserId: email, actorEmail: email, workspaceId, ipAddress: ip, details: { motivo: 'prueba' } });
    await record('LOGIN_SUCCESS', 'ana@acme.com', '192.0.2.1');
    await record('CONNECTION_CREATED', 'ana@acme.com', '192.0.2.1');
    await record('EXECUTE_JOIN', 'luis@acme.com', '198.51.100.7');
    await record('LOGIN_FAILURE', 'luis@acme.com', '198.51.100.7', 'FAILURE');
    await record('CONNECTION_CREATED', 'otro@otra.com', '203.0.113.9', 'SUCCESS', other.id);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE "RegistroAuditoria" DISABLE TRIGGER USER').catch(() => undefined);
    await prisma.registroAuditoria.deleteMany({ where: { workspaceId: { in: [auditor.workspaceId, otherWorkspace] } } }).catch(() => undefined);
    await prisma.$executeRawUnsafe('ALTER TABLE "RegistroAuditoria" ENABLE TRIGGER USER').catch(() => undefined);
    await prisma.workspace.deleteMany({ where: { nombreEmpresa: { startsWith: marker } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('cada evento trae su impacto y se filtra por impacto', async () => {
    const page = await audit.findAll(auditor, { impacto: 'ALTO' });
    expect(page.data.map((row) => row.eventType)).toEqual(['CONNECTION_CREATED']);
    expect(page.data[0].impacto).toBe('ALTO');
  });

  it('busca por correo o IP sin salir del workspace', async () => {
    expect((await audit.findAll(auditor, { buscar: 'LUIS@' })).total).toBe(2);
    expect((await audit.findAll(auditor, { buscar: '192.0.2.1' })).total).toBe(2);
    expect((await audit.findAll(auditor, { buscar: 'otro@otra.com' })).total).toBe(0);
  });

  it('el inspector devuelve el detalle solo dentro del workspace', async () => {
    const [first] = (await audit.findAll(auditor, { tipoAccion: 'EXECUTE_JOIN' })).data;
    await expect(audit.findOne(auditor, first.id)).resolves.toMatchObject({ eventType: 'EXECUTE_JOIN', impacto: 'MEDIO', ipAddress: '198.51.100.7' });
    const foreign = await prisma.registroAuditoria.findFirstOrThrow({ where: { workspaceId: otherWorkspace } });
    await expect(audit.findOne(auditor, foreign.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resume el período: eventos, usuarios con actividad, fallos e impacto', async () => {
    await expect(audit.summary(auditor, 7)).resolves.toMatchObject({
      dias: 7,
      eventos: 4,
      usuariosActivos: 2,
      fallos: 1,
      porImpacto: { BAJO: 1, MEDIO: 2, ALTO: 1 },
    });
  });
});
