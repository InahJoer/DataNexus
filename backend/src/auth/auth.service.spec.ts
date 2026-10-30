import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { RegisterDto } from './dto/register.dto.js';

describe('AuthService', () => {
  let authService: AuthService;
  let prismaService: any;
  let jwtService: any;
  let auditService: any;

  beforeEach(() => {
    prismaService = {
      workspace: {
        findUnique: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    };

    jwtService = {
      sign: vi.fn().mockReturnValue('mocked.jwt.token'),
    };

    auditService = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    authService = new AuthService(
      prismaService as unknown as PrismaService,
      jwtService as unknown as JwtService,
      auditService as unknown as AuditService,
    );
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

    const result = await authService.login(
      {
        email: 'admin@datanexus.com',
        password: plainPassword,
      },
      { ipAddress: '192.0.2.10', userAgent: 'phase3-test' },
    );

    expect(result).toHaveProperty('access_token', 'mocked.jwt.token');
    expect(result.user).toEqual({
      id: 'user-uuid-1',
      email: 'admin@datanexus.com',
      name: 'Admin Test',
      role: 'ADMIN',
      workspaceId: 'ws-uuid-1',
    });
    expect(jwtService.sign).toHaveBeenCalled();
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'LOGIN_SUCCESS',
        outcome: 'SUCCESS',
        actorUserId: 'user-uuid-1',
        actorEmail: 'admin@datanexus.com',
        workspaceId: 'ws-uuid-1',
        ipAddress: '192.0.2.10',
        userAgent: 'phase3-test',
      }),
    );
  });

  it('debe arrojar UnauthorizedException si el usuario no existe', async () => {
    prismaService.user.findUnique.mockResolvedValue(null);

    await expect(
      authService.login({
        email: 'inexistente@datanexus.com',
        password: 'Password123!',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'LOGIN_FAILURE',
        outcome: 'FAILURE',
        actorEmail: 'inexistente@datanexus.com',
      }),
    );
    expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('Password123!');
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
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'LOGIN_FAILURE',
        outcome: 'FAILURE',
        actorUserId: 'user-uuid-1',
      }),
    );
    expect(JSON.stringify(auditService.record.mock.calls)).not.toContain('WrongPassword!');
  });

  it('always registers public users with the LECTOR role', async () => {
    prismaService.user.findUnique.mockResolvedValue(null);
    prismaService.workspace.findUnique.mockResolvedValue({
      id: 'ws-uuid-1',
      nombreEmpresa: 'DataNexus Corp',
    });
    prismaService.user.create.mockResolvedValue({
      id: 'user-uuid-2',
      email: 'new@datanexus.com',
      name: 'New User',
      role: 'LECTOR',
      workspaceId: 'ws-uuid-1',
    });

    await authService.register({
      email: 'new@datanexus.com',
      name: 'New User',
      password: 'Password123!',
      workspaceId: 'ws-uuid-1',
      role: 'ADMIN',
    } as RegisterDto & { role: string });

    expect(prismaService.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'LECTOR' }),
      }),
    );
  });
});
