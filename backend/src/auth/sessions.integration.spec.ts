import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from './sessions.service.js';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface.js';

/** Flujo completo de sesiones contra PostgreSQL real (requiere DATABASE_URL con migraciones aplicadas). */
describe.skipIf(!process.env.DATABASE_URL)('Sesiones y refresh tokens en PostgreSQL', () => {
  const prisma = new PrismaService();
  const jwt = new JwtService({ secret: 'x'.repeat(40), signOptions: { expiresIn: '15m' } });
  const sessions = new SessionsService(prisma, jwt, new AuditService(prisma), {
    get: () => undefined,
  } as unknown as ConfigService);
  const marker = `sesiones-${Date.now()}`;
  let user: AuthenticatedUser;

  const sidOf = (accessToken: string) => jwt.decode<{ sid: string }>(accessToken).sid;
  const session = (id: string) => prisma.userSession.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await prisma.$connect();
    const workspace = await prisma.workspace.create({ data: { nombreEmpresa: marker } });
    const created = await prisma.user.create({
      data: { email: `${marker}@datanexus.test`, name: 'Sesión', password: 'x', role: 'OPERADOR', workspaceId: workspace.id },
    });
    user = { id: created.id, email: created.email, name: created.name, role: 'OPERADOR', workspaceId: workspace.id };
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { nombreEmpresa: marker } });
    await prisma.$disconnect();
  });

  it('el login emite access token con sid, refresh token y 900 s de vida', async () => {
    const tokens = await sessions.startSession(user, { ipAddress: '192.0.2.10' });
    const sid = sidOf(tokens.access_token);

    expect(tokens.expires_in).toBe(900);
    expect(tokens.refresh_token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect((await session(sid)).ipAddress).toBe('192.0.2.10');
    await expect(sessions.assertActive(sid, user.id)).resolves.toBeUndefined();
    await expect(sessions.assertActive(sid, 'otro-usuario')).rejects.toThrow(UnauthorizedException);
  });

  it('rota el refresh token y conserva la misma sesión', async () => {
    const first = await sessions.startSession(user);
    const second = await sessions.refresh(first.refresh_token);

    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(sidOf(second.access_token)).toBe(sidOf(first.access_token));
    expect(second.user).toMatchObject({ id: user.id, role: 'OPERADOR' });
  });

  it('reutilizar un refresh token ya rotado revoca toda la sesión', async () => {
    const first = await sessions.startSession(user);
    const sid = sidOf(first.access_token);
    const second = await sessions.refresh(first.refresh_token);

    await expect(sessions.refresh(first.refresh_token)).rejects.toThrow(UnauthorizedException);
    expect((await session(sid)).revokedReason).toBe('reutilizacion');
    // El token legítimo más reciente y los access tokens también dejan de servir.
    await expect(sessions.refresh(second.refresh_token)).rejects.toThrow(UnauthorizedException);
    await expect(sessions.assertActive(sid, user.id)).rejects.toThrow(UnauthorizedException);

    const audit = await prisma.registroAuditoria.findFirst({ where: { eventType: 'REFRESH_TOKEN_REUSED', targetId: sid } });
    expect(audit?.outcome).toBe('FAILURE');
  });

  it('logout invalida de inmediato el refresh token y los access tokens', async () => {
    const tokens = await sessions.startSession(user);
    const sid = sidOf(tokens.access_token);

    await sessions.logout(tokens.refresh_token);

    expect((await session(sid)).revokedReason).toBe('logout');
    await expect(sessions.refresh(tokens.refresh_token)).rejects.toThrow(UnauthorizedException);
    await expect(sessions.assertActive(sid, user.id)).rejects.toThrow(UnauthorizedException);
    await expect(sessions.logout(tokens.refresh_token)).resolves.toBeUndefined();
  });

  it('tras 30 minutos sin actividad el refresh responde 401 y la sesión se cierra', async () => {
    const tokens = await sessions.startSession(user);
    const sid = sidOf(tokens.access_token);
    await prisma.userSession.update({ where: { id: sid }, data: { lastActivityAt: new Date(Date.now() - 31 * 60_000) } });

    await expect(sessions.refresh(tokens.refresh_token)).rejects.toThrow(UnauthorizedException);
    expect((await session(sid)).revokedReason).toBe('inactividad');
  });

  it('un access token también se rechaza tras 30 minutos de inactividad', async () => {
    const tokens = await sessions.startSession(user);
    const sid = sidOf(tokens.access_token);
    await prisma.userSession.update({ where: { id: sid }, data: { lastActivityAt: new Date(Date.now() - 31 * 60_000) } });

    await expect(sessions.assertActive(sid, user.id)).rejects.toThrow(UnauthorizedException);
    expect((await session(sid)).revokedReason).toBe('inactividad');
  });

  it('las peticiones autenticadas cuentan como actividad', async () => {
    const tokens = await sessions.startSession(user);
    const sid = sidOf(tokens.access_token);
    const old = new Date(Date.now() - 20 * 60_000);
    await prisma.userSession.update({ where: { id: sid }, data: { lastActivityAt: old } });

    await sessions.assertActive(sid, user.id);

    expect((await session(sid)).lastActivityAt.getTime()).toBeGreaterThan(old.getTime() + 60_000);
  });

  it('una sesión vencida por tiempo absoluto se rechaza', async () => {
    const tokens = await sessions.startSession(user);
    const sid = sidOf(tokens.access_token);
    await prisma.userSession.update({ where: { id: sid }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(sessions.refresh(tokens.refresh_token)).rejects.toThrow(UnauthorizedException);
    expect((await session(sid)).revokedReason).toBe('vencida');
  });

  it('dos renovaciones simultáneas con el mismo token se tratan como reutilización', async () => {
    const tokens = await sessions.startSession(user);
    const results = await Promise.allSettled([
      sessions.refresh(tokens.refresh_token),
      sessions.refresh(tokens.refresh_token),
    ]);

    expect(results.filter((r) => r.status === 'rejected')).not.toHaveLength(0);
    expect((await session(sidOf(tokens.access_token))).revokedAt).not.toBeNull();
  });

  it('revokeAllForUser cierra todas las sesiones activas del usuario', async () => {
    const a = await sessions.startSession(user);
    const b = await sessions.startSession(user);

    expect(await sessions.revokeAllForUser(user.id, 'cambio_contrasena')).toBeGreaterThanOrEqual(2);
    await expect(sessions.refresh(a.refresh_token)).rejects.toThrow(UnauthorizedException);
    await expect(sessions.refresh(b.refresh_token)).rejects.toThrow(UnauthorizedException);
  });

  it('un refresh token desconocido responde 401', async () => {
    await expect(sessions.refresh('a'.repeat(64))).rejects.toThrow(UnauthorizedException);
  });
});
