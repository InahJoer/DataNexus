import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from './interfaces/authenticated-user.interface.js';
import type { JwtPayload } from './interfaces/jwt-payload.interface.js';
import { isUserRole } from './interfaces/user-role.js';

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
export const DEFAULT_REFRESH_TTL_DAYS = 7;
/** Para no escribir en cada petición: la actividad solo se actualiza si pasó más de este tiempo. */
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

export const SESSION_EXPIRED_MESSAGE = 'Tu sesión expiró. Inicia sesión de nuevo.';

export type RevokeReason = 'logout' | 'inactividad' | 'vencida' | 'reutilizacion' | 'cambio_contrasena';

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  /** Segundos de vida del access token. */
  expires_in: number;
}

type TxClient = Prisma.TransactionClient;

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const newRefreshToken = (): string => randomBytes(48).toString('base64url');

/**
 * Sesiones con refresh token rotativo y cierre por inactividad (RF-04).
 *
 * - Cada login crea una UserSession. El access token (15 min) lleva su id en `sid`.
 * - JwtStrategy valida la sesión en cada petición: logout, inactividad o revocación
 *   invalidan también los access tokens emitidos, no solo el refresh token.
 * - El refresh token se rota en cada uso. Presentar uno ya rotado indica robo:
 *   se revoca la sesión completa (toda la familia de tokens).
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  get idleTimeoutMs(): number {
    return this.positiveNumber('SESSION_IDLE_TIMEOUT_MINUTES', DEFAULT_IDLE_TIMEOUT_MINUTES) * 60_000;
  }

  private get refreshTtlMs(): number {
    return this.positiveNumber('REFRESH_TOKEN_TTL_DAYS', DEFAULT_REFRESH_TTL_DAYS) * 86_400_000;
  }

  private positiveNumber(key: string, fallback: number): number {
    const value = Number(this.configService.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  /** Crea una sesión nueva tras un login correcto y emite el par de tokens. */
  async startSession(user: AuthenticatedUser, context: RequestAuditContext = {}): Promise<IssuedTokens> {
    const now = Date.now();
    const refreshToken = newRefreshToken();

    // Limpieza oportunista de sesiones viejas del mismo usuario.
    await this.prisma.userSession.deleteMany({
      where: {
        userId: user.id,
        OR: [{ expiresAt: { lt: new Date(now) } }, { revokedAt: { lt: new Date(now - this.refreshTtlMs) } }],
      },
    });

    const session = await this.prisma.userSession.create({
      data: {
        userId: user.id,
        lastActivityAt: new Date(now),
        expiresAt: new Date(now + this.refreshTtlMs),
        ipAddress: context.ipAddress?.slice(0, 128),
        userAgent: context.userAgent?.slice(0, 512),
        refreshTokens: { create: { tokenHash: hashRefreshToken(refreshToken) } },
      },
      select: { id: true },
    });

    return this.issue(user, session.id, refreshToken);
  }

  /** Rota el refresh token. Lanza 401 si es inválido, la sesión expiró o hubo reutilización. */
  async refresh(
    rawToken: string,
    context: RequestAuditContext = {},
  ): Promise<IssuedTokens & { user: AuthenticatedUser }> {
    const now = new Date();
    const nextToken = newRefreshToken();

    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await tx.refreshToken.findUnique({
        where: { tokenHash: hashRefreshToken(rawToken) },
        select: {
          id: true,
          rotatedAt: true,
          session: {
            select: {
              id: true,
              revokedAt: true,
              expiresAt: true,
              lastActivityAt: true,
              user: { select: { id: true, email: true, name: true, role: true, workspaceId: true } },
            },
          },
        },
      });

      if (!current) return { kind: 'invalid' as const };
      const { session } = current;
      const user = session.user;

      if (session.revokedAt) return { kind: 'invalid' as const };
      if (current.rotatedAt) return { kind: 'reused' as const, sessionId: session.id, user };
      if (session.expiresAt <= now) return { kind: 'expired' as const, sessionId: session.id, user, reason: 'vencida' as const };
      if (now.getTime() - session.lastActivityAt.getTime() > this.idleTimeoutMs) {
        return { kind: 'expired' as const, sessionId: session.id, user, reason: 'inactividad' as const };
      }
      if (!isUserRole(user.role)) return { kind: 'invalid' as const };

      // Consumo atómico: dos renovaciones simultáneas con el mismo token cuentan como reutilización.
      const consumed = await tx.refreshToken.updateMany({
        where: { id: current.id, rotatedAt: null },
        data: { rotatedAt: now },
      });
      if (consumed.count !== 1) return { kind: 'reused' as const, sessionId: session.id, user };

      await tx.refreshToken.create({ data: { sessionId: session.id, tokenHash: hashRefreshToken(nextToken) } });
      await tx.userSession.update({ where: { id: session.id }, data: { lastActivityAt: now } });
      return { kind: 'ok' as const, sessionId: session.id, user: { ...user, role: user.role } };
    });

    if (outcome.kind === 'ok') {
      const user = outcome.user as AuthenticatedUser;
      return { ...this.issue(user, outcome.sessionId, nextToken), user };
    }

    if (outcome.kind === 'reused') {
      await this.revokeSession(outcome.sessionId, 'reutilizacion');
      await this.auditService.record({
        eventType: 'REFRESH_TOKEN_REUSED',
        outcome: 'FAILURE',
        actorUserId: outcome.user.id,
        actorEmail: outcome.user.email,
        workspaceId: outcome.user.workspaceId,
        targetType: 'SESSION',
        targetId: outcome.sessionId,
        ...context,
      });
    }

    if (outcome.kind === 'expired') {
      await this.revokeSession(outcome.sessionId, outcome.reason);
      await this.auditService.record({
        eventType: 'SESSION_EXPIRED',
        outcome: 'SUCCESS',
        actorUserId: outcome.user.id,
        actorEmail: outcome.user.email,
        workspaceId: outcome.user.workspaceId,
        targetType: 'SESSION',
        targetId: outcome.sessionId,
        details: { motivo: outcome.reason },
        ...context,
      });
    }

    throw new UnauthorizedException(SESSION_EXPIRED_MESSAGE);
  }

  /** Cierra la sesión dueña del refresh token. Idempotente: un token desconocido no es error. */
  async logout(rawToken: string, context: RequestAuditContext = {}): Promise<void> {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(rawToken) },
      select: {
        session: {
          select: { id: true, revokedAt: true, user: { select: { id: true, email: true, workspaceId: true } } },
        },
      },
    });
    if (!token || token.session.revokedAt) return;

    await this.revokeSession(token.session.id, 'logout');
    await this.auditService.record({
      eventType: 'LOGOUT',
      outcome: 'SUCCESS',
      actorUserId: token.session.user.id,
      actorEmail: token.session.user.email,
      workspaceId: token.session.user.workspaceId,
      targetType: 'SESSION',
      targetId: token.session.id,
      ...context,
    });
  }

  /**
   * Usado por JwtStrategy en cada petición autenticada: verifica que la sesión siga activa
   * y registra la actividad. Lanza 401 si fue revocada, venció o superó la inactividad.
   */
  async assertActive(sessionId: string, userId: string): Promise<void> {
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, revokedAt: true, expiresAt: true, lastActivityAt: true },
    });
    const now = Date.now();

    if (!session || session.userId !== userId || session.revokedAt || session.expiresAt.getTime() <= now) {
      throw new UnauthorizedException(SESSION_EXPIRED_MESSAGE);
    }
    if (now - session.lastActivityAt.getTime() > this.idleTimeoutMs) {
      await this.revokeSession(sessionId, 'inactividad');
      throw new UnauthorizedException(SESSION_EXPIRED_MESSAGE);
    }
    if (now - session.lastActivityAt.getTime() > ACTIVITY_WRITE_INTERVAL_MS) {
      await this.prisma.userSession.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { lastActivityAt: new Date(now) },
      });
    }
  }

  /** Revoca todas las sesiones activas de un usuario (p. ej. al cambiar su contraseña). */
  async revokeAllForUser(userId: string, reason: RevokeReason, tx?: TxClient): Promise<number> {
    const client = tx ?? this.prisma;
    const result = await client.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  private async revokeSession(sessionId: string, reason: RevokeReason): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  private issue(user: AuthenticatedUser, sessionId: string, refreshToken: string): IssuedTokens {
    const payload: JwtPayload = {
      sub: user.id,
      sid: sessionId,
      email: user.email,
      name: user.name,
      role: user.role,
      workspaceId: user.workspaceId,
    };
    const accessToken = this.jwtService.sign(payload);
    const decoded = this.jwtService.decode<{ iat?: number; exp?: number } | null>(accessToken);
    const expiresIn = decoded?.exp && decoded.iat ? decoded.exp - decoded.iat : 900;

    return { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };
  }
}
