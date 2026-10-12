import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('AuthService', () => {
  let authService: AuthService;
  let prismaService: any;
  let jwtService: any;

  beforeEach(() => {
    prismaService = {
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    };

    jwtService = {
      sign: vi.fn().mockReturnValue('mocked.jwt.token'),
    };

    authService = new AuthService(prismaService as unknown as PrismaService, jwtService as unknown as JwtService);
  });

  it('debe estar definido', () => {
    expect(authService).toBeDefined();
  });

  it('debe autenticar exitosamente y retornar token JWT si credenciales son correctas', async () => {
    const plainPassword = 'Password123!';
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    prismaService.user.findUnique.mockResolvedValue({
      id: 'user-uuid-1',
      email: 'admin@datanexus.com',
      name: 'Admin Test',
      password: hashedPassword,
      role: 'ADMIN',
      workspaceId: 'ws-uuid-1',
    });

    const result = await authService.login({
      email: 'admin@datanexus.com',
      password: plainPassword,
    });

    expect(result).toHaveProperty('access_token', 'mocked.jwt.token');
    expect(result.user).toEqual({
      id: 'user-uuid-1',
      email: 'admin@datanexus.com',
      name: 'Admin Test',
      role: 'ADMIN',
      workspaceId: 'ws-uuid-1',
    });
    expect(jwtService.sign).toHaveBeenCalled();
  });

  it('debe arrojar UnauthorizedException si el usuario no existe', async () => {
    prismaService.user.findUnique.mockResolvedValue(null);

    await expect(
      authService.login({
        email: 'inexistente@datanexus.com',
        password: 'Password123!',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('debe arrojar UnauthorizedException si la contraseña es incorrecta', async () => {
    const hashedPassword = await bcrypt.hash('CorrectPassword123!', 10);

    prismaService.user.findUnique.mockResolvedValue({
      id: 'user-uuid-1',
      email: 'admin@datanexus.com',
      name: 'Admin Test',
      password: hashedPassword,
      role: 'ADMIN',
      workspaceId: 'ws-uuid-1',
    });

    await expect(
      authService.login({
        email: 'admin@datanexus.com',
        password: 'WrongPassword!',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
