import { Injectable, UnauthorizedException, ConflictException, NotFoundException } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestAuditContext } from './interfaces/authenticated-user.interface.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { SessionsService } from './sessions.service.js';
import { isUserRole } from './interfaces/user-role.js';
import type { AuthResponseDto } from './dto/auth-response.dto.js';
import { AccountLockedException, getLockoutPolicy } from './login-lockout.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Valida las credenciales, abre una sesión y emite access token (15 min) y refresh token.
   * @param loginDto Datos de autenticación (email y contraseña)
   * @returns Token JWT de acceso y datos públicos del usuario
   */
  async login(
    loginDto: LoginDto,
    requestContext: RequestAuditContext = {},
  ): Promise<AuthResponseDto> {
    const normalizedEmail = loginDto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      await this.auditService.record({
        eventType: 'LOGIN_FAILURE',
        outcome: 'FAILURE',
        actorEmail: normalizedEmail,
        details: { motivo: 'usuario_no_encontrado' },
        ...requestContext,
      });
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const actor = { actorUserId: user.id, actorEmail: user.email, workspaceId: user.workspaceId };

    // Cuenta bloqueada: ni siquiera se compara la contraseña.
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.auditService.record({
        eventType: 'LOGIN_FAILURE',
        outcome: 'FAILURE',
        ...actor,
        details: { motivo: 'cuenta_bloqueada', bloqueadoHasta: user.lockedUntil.toISOString() },
        ...requestContext,
      });
      throw new AccountLockedException(user.lockedUntil);
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.password);
    if (!isPasswordValid) {
      await this.registerFailedAttempt(user.id, actor, requestContext);
    }
    if (!isUserRole(user.role)) {
      await this.auditService.record({
        eventType: 'LOGIN_FAILURE',
        outcome: 'FAILURE',
        ...actor,
        details: { motivo: 'rol_invalido' },
        ...requestContext,
      });
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    const authenticatedUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      workspaceId: user.workspaceId,
    };
    const tokens = await this.sessionsService.startSession(authenticatedUser, requestContext);

    await this.auditService.record({
      eventType: 'LOGIN_SUCCESS',
      outcome: 'SUCCESS',
      actorUserId: user.id,
      actorEmail: user.email,
      workspaceId: user.workspaceId,
      ...requestContext,
    });

    return { ...tokens, user: authenticatedUser };
  }

  /**
   * Suma un intento fallido de forma atómica. Al llegar a LOGIN_MAX_ATTEMPTS (5) bloquea la
   * cuenta LOGIN_LOCK_MINUTES (15) y responde 423; si no, responde 401. Siempre lanza.
   */
  private async registerFailedAttempt(
    userId: string,
    actor: { actorUserId: string; actorEmail: string; workspaceId: string },
    requestContext: RequestAuditContext,
  ): Promise<never> {
    const policy = getLockoutPolicy((key) => process.env[key]);
    const { failedLoginAttempts } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });

    if (failedLoginAttempts >= policy.maxAttempts) {
      const lockedUntil = new Date(Date.now() + policy.lockMs);
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil, failedLoginAttempts: 0 },
      });
      await this.auditService.record({
        eventType: 'ACCOUNT_LOCKED',
        outcome: 'FAILURE',
        ...actor,
        targetType: 'USER',
        targetId: userId,
        details: {
          intentos: failedLoginAttempts,
          bloqueoMinutos: policy.lockMs / 60_000,
          bloqueadoHasta: lockedUntil.toISOString(),
        },
        ...requestContext,
      });
      throw new AccountLockedException(lockedUntil);
    }

    await this.auditService.record({
      eventType: 'LOGIN_FAILURE',
      outcome: 'FAILURE',
      ...actor,
      details: { motivo: 'credenciales_invalidas', intentos: failedLoginAttempts },
      ...requestContext,
    });
    throw new UnauthorizedException('Credenciales inválidas');
  }

  /**
   * Registra un nuevo usuario con la contraseña encriptada mediante bcrypt.
   * Método de utilidad para crear usuarios válidos y poblar el sistema.
   * @param registerDto Datos para el registro del usuario
   */
  async register(registerDto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: registerDto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException('Ya existe un usuario con este correo electrónico');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: registerDto.workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException(`El workspace con ID ${registerDto.workspaceId} no existe`);
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(registerDto.password, saltRounds);

    const newUser = await this.prisma.user.create({
      data: {
        email: registerDto.email.toLowerCase(),
        name: registerDto.name,
        password: hashedPassword,
        role: 'LECTOR',
        workspaceId: registerDto.workspaceId,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        workspaceId: true,
      },
    });

    return newUser;
  }
}
