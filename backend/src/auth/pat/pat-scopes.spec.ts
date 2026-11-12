import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequirePermission } from '../decorators/roles.decorator.js';
import { JwtAuthGuard, PAT_NOT_ALLOWED_MESSAGE } from '../guards/jwt-auth.guard.js';
import { ROLE_PERMISSIONS } from '../interfaces/user-role.js';
import { PAT_SCOPES, permissionsOfScopes, roleCanGrantScope, scopesForRole } from './pat-scopes.js';
import type { PersonalAccessTokensService } from './personal-access-tokens.service.js';

describe('alcances de los tokens de acceso personal', () => {
  it('ningún alcance concede permisos de escritura o gestión', () => {
    const granted = new Set(Object.values(PAT_SCOPES).flat());
    for (const forbidden of ['MANAGE_CONNECTIONS', 'MANAGE_MEMBERS', 'MANAGE_WORKSPACE', 'MANAGE_QUERIES', 'MANAGE_REPORTS', 'MODIFY_RECORDS']) {
      expect(granted.has(forbidden as never)).toBe(false);
    }
    for (const permission of granted) expect(Object.keys(ROLE_PERMISSIONS)).toContain(permission);
  });

  it('cada rol solo puede conceder los alcances cubiertos por sus permisos', () => {
    expect(scopesForRole('ADMIN')).toEqual(['queries:read', 'results:read', 'exports:create', 'connections:read', 'audit:read']);
    expect(scopesForRole('OPERADOR')).toEqual(['queries:read', 'results:read', 'exports:create', 'connections:read']);
    expect(scopesForRole('LECTOR')).toEqual(['queries:read']);
    expect(scopesForRole('AUDITOR')).toEqual(['audit:read']);
    expect(roleCanGrantScope('LECTOR', 'exports:create')).toBe(false);
  });

  it('traduce alcances a permisos sin duplicados e ignora alcances desconocidos', () => {
    expect(permissionsOfScopes(['results:read', 'queries:read', 'results:read', 'admin:*'])).toEqual([
      'RUN_JOINS',
      'EXPLORE_DATA',
      'RUN_SAVED_QUERIES',
    ]);
  });
});

describe('JwtAuthGuard con tokens de acceso personal', () => {
  class Demo {
    @RequirePermission('RUN_SAVED_QUERIES')
    run() {}

    profile() {}
  }

  const contextFor = (method: 'run' | 'profile', authorization: string) => {
    const request: Record<string, unknown> = { headers: { authorization }, ip: '10.0.0.1', get: () => 'curl/8' };
    const handler = Object.getOwnPropertyDescriptor(Demo.prototype, method)?.value as () => void;
    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => handler,
        getClass: () => Demo,
      } as unknown as ExecutionContext,
    };
  };

  const guardWith = (tokenPermissions: string[]) => {
    const authenticate = vi.fn().mockResolvedValue({ id: 'u1', role: 'LECTOR', authMethod: 'pat', tokenPermissions });
    return { authenticate, guard: new JwtAuthGuard(new Reflector(), { authenticate } as unknown as PersonalAccessTokensService) };
  };

  it('acepta el token en un endpoint cuyo permiso concede y deja al usuario en la petición', async () => {
    const { guard, authenticate } = guardWith(['RUN_SAVED_QUERIES']);
    const { context, request } = contextFor('run', 'Bearer pat_abc');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith('pat_abc', { ipAddress: '10.0.0.1', userAgent: 'curl/8' });
    expect(request.user).toMatchObject({ id: 'u1', authMethod: 'pat' });
  });

  it('rechaza el token si su alcance no cubre el permiso del endpoint', async () => {
    const { guard } = guardWith(['READ_AUDIT']);
    await expect(guard.canActivate(contextFor('run', 'Bearer pat_abc').context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechaza el token en endpoints sin permiso RBAC (perfil, sesiones, gestión de tokens)', async () => {
    const { guard } = guardWith(['RUN_SAVED_QUERIES']);
    await expect(guard.canActivate(contextFor('profile', 'Bearer pat_abc').context)).rejects.toThrow(PAT_NOT_ALLOWED_MESSAGE);
  });
});
