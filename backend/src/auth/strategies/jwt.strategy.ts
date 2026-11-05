import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { JwtPayload } from '../interfaces/jwt-payload.interface.js';
import { isUserRole } from '../interfaces/user-role.js';
import { getJwtSecret } from '../jwt-secret.js';
import { SESSION_EXPIRED_MESSAGE, SessionsService } from '../sessions.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(configService),
    });
  }

  async validate(payload: JwtPayload) {
    // Tokens emitidos antes de las sesiones (sin sid) ya no son válidos.
    if (typeof payload.sid !== 'string' || payload.sid.length === 0) {
      throw new UnauthorizedException(SESSION_EXPIRED_MESSAGE);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        workspaceId: true,
      },
    });

    if (!user || !isUserRole(user.role)) {
      throw new UnauthorizedException('El token no corresponde a un usuario activo con un rol válido');
    }

    await this.sessionsService.assertActive(payload.sid, user.id);
    return user;
  }
}
