import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { REQUIRED_PERMISSION_KEY } from '../decorators/roles.decorator.js';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface.js';
import type { Permission } from '../interfaces/user-role.js';
import { PAT_PREFIX } from '../pat/pat-scopes.js';
import { PersonalAccessTokensService } from '../pat/personal-access-tokens.service.js';

export const PAT_NOT_ALLOWED_MESSAGE =
  'Los tokens de acceso personal solo sirven para endpoints de integración. Inicia sesión para usar este endpoint.';

function bearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * Autenticación de la API: sesión (JWT) o token de acceso personal `pat_...` (issue #65).
 *
 * Un token de acceso personal solo se acepta en endpoints con @RequirePermission y cuyo permiso esté entre
 * los que concede el token. RolesGuard comprueba después el rol **actual** del dueño, así que el permiso
 * efectivo es la intersección de ambos: un token nunca da más que el rol de su dueño.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly personalAccessTokens: PersonalAccessTokensService,
  ) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = bearerToken(request);
    if (!token?.startsWith(PAT_PREFIX)) return (await super.canActivate(context)) as boolean;

    const user = await this.personalAccessTokens.authenticate(token, {
      ipAddress: request.ip,
      userAgent: request.get?.('user-agent') ?? undefined,
    });
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) throw new ForbiddenException(PAT_NOT_ALLOWED_MESSAGE);
    if (!user.tokenPermissions?.includes(permission)) {
      throw new ForbiddenException(`Este token no tiene permiso para esta operación (${permission})`);
    }
    request.user = user;
    return true;
  }
}
