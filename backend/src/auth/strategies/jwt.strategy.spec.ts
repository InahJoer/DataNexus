import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { SessionsService } from '../sessions.service.js';
import type { JwtPayload } from '../interfaces/jwt-payload.interface.js';
import { JwtStrategy } from './jwt.strategy.js';

const dbUser = { id: 'u1', email: 'u1@corp.com', name: 'U1', role: 'ADMIN', workspaceId: 'ws-1' };

function setup(assertActive = vi.fn().mockResolvedValue(undefined)) {
  const prisma = { user: { findUnique: vi.fn().mockResolvedValue(dbUser) } };
  const strategy = new JwtStrategy(
    { getOrThrow: () => 'x'.repeat(40) } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    { assertActive } as unknown as SessionsService,
  );
  return { strategy, prisma, assertActive };
}

const payload = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'u1',
  sid: 's1',
  email: 'u1@corp.com',
  name: 'U1',
  role: 'ADMIN',
  workspaceId: 'ws-1',
  ...overrides,
});

describe('JwtStrategy', () => {
  it('valida la sesión del token y devuelve el usuario de la base', async () => {
    const { strategy, assertActive } = setup();
    // Lleva además la sesión del token, para poder cerrar las demás sin cerrar la actual.
    await expect(strategy.validate(payload())).resolves.toEqual({ ...dbUser, sessionId: 's1' });
    expect(assertActive).toHaveBeenCalledWith('s1', 'u1');
  });

  it('rechaza tokens sin sid (emitidos antes de las sesiones)', async () => {
    const { strategy, prisma } = setup();
    await expect(strategy.validate(payload({ sid: undefined as unknown as string }))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rechaza el token si la sesión fue cerrada o expiró por inactividad', async () => {
    const { strategy } = setup(vi.fn().mockRejectedValue(new UnauthorizedException()));
    await expect(strategy.validate(payload())).rejects.toThrow(UnauthorizedException);
  });
});
