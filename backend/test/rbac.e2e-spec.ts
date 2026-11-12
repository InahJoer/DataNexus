import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, USER_ROLES, hasPermission, type Permission, type UserRole } from '../src/auth/interfaces/user-role.js';
import { bearer, createE2eApp, seedWorkspace, type E2eApp, type E2eWorkspace } from './e2e/helpers.js';

type Method = 'get' | 'post' | 'patch' | 'delete';

interface ProtectedRoute {
  method: Method;
  path: string;
  permission: Permission;
  /** Cuerpo que se envía: vacío o inválido a propósito, para no modificar datos. */
  body?: Record<string, unknown>;
}

const missing = randomUUID();

/**
 * Un endpoint representativo (o varios) por permiso de la matriz RBAC.
 * Las peticiones permitidas llevan cuerpos vacíos o ids inexistentes: deben pasar el guard (≠ 401/403)
 * y fallar después (400/404) sin cambiar datos. Las denegadas deben responder 403.
 */
const ROUTES: ProtectedRoute[] = [
  { method: 'get', path: '/connections', permission: 'VIEW_CONNECTIONS' },
  { method: 'get', path: `/connections/${missing}`, permission: 'VIEW_CONNECTIONS' },
  { method: 'get', path: '/engine/connections/health', permission: 'VIEW_CONNECTIONS' },
  { method: 'post', path: '/connections', permission: 'MANAGE_CONNECTIONS', body: {} },
  { method: 'patch', path: `/connections/${missing}`, permission: 'MANAGE_CONNECTIONS', body: { nombre: 'x' } },
  { method: 'delete', path: `/connections/${missing}`, permission: 'MANAGE_CONNECTIONS' },
  { method: 'get', path: `/engine/connections/${missing}/schema`, permission: 'EXPLORE_DATA' },
  { method: 'get', path: `/engine/connections/${missing}/data?entidad=x`, permission: 'EXPLORE_DATA' },
  { method: 'post', path: '/engine/join', permission: 'RUN_JOINS', body: {} },
  { method: 'post', path: '/engine/export', permission: 'EXPORT_DATA', body: {} },
  { method: 'post', path: '/engine/export/data', permission: 'EXPORT_DATA', body: {} },
  { method: 'patch', path: '/engine/records', permission: 'MODIFY_RECORDS', body: {} },
  { method: 'get', path: '/reports/schedules', permission: 'MANAGE_REPORTS' },
  { method: 'post', path: '/reports/schedules', permission: 'MANAGE_REPORTS', body: {} },
  { method: 'get', path: '/reports/executions', permission: 'MANAGE_REPORTS' },
  { method: 'post', path: '/reports/trigger', permission: 'MANAGE_REPORTS', body: {} },
  { method: 'get', path: '/audit/logs', permission: 'READ_AUDIT' },
  { method: 'get', path: '/audit/summary', permission: 'READ_AUDIT' },
  { method: 'get', path: `/audit/logs/${missing}`, permission: 'READ_AUDIT' },
  { method: 'get', path: '/users', permission: 'MANAGE_MEMBERS' },
  { method: 'get', path: '/users/invitations', permission: 'MANAGE_MEMBERS' },
  { method: 'post', path: '/users/invite', permission: 'MANAGE_MEMBERS', body: {} },
  { method: 'patch', path: `/users/${missing}/role`, permission: 'MANAGE_MEMBERS', body: { role: 'LECTOR' } },
  { method: 'delete', path: `/users/${missing}`, permission: 'MANAGE_MEMBERS' },
  { method: 'patch', path: '/workspaces/me', permission: 'MANAGE_WORKSPACE', body: { zonaHoraria: 'no/valida' } },
  { method: 'get', path: '/workspaces/me/sensitive-fields', permission: 'MANAGE_WORKSPACE' },
  { method: 'post', path: '/workspaces/me/sensitive-fields', permission: 'MANAGE_WORKSPACE', body: {} },
  { method: 'post', path: '/queries', permission: 'MANAGE_QUERIES', body: {} },
  { method: 'delete', path: `/queries/${missing}`, permission: 'MANAGE_QUERIES' },
  { method: 'get', path: `/queries/${missing}/versions`, permission: 'MANAGE_QUERIES' },
  { method: 'get', path: '/queries', permission: 'RUN_SAVED_QUERIES' },
  { method: 'post', path: `/queries/${missing}/run`, permission: 'RUN_SAVED_QUERIES', body: {} },
];

/** Endpoints que cualquier usuario autenticado puede usar, sea cual sea su rol. */
const ANY_AUTHENTICATED: Array<{ method: Method; path: string }> = [
  { method: 'get', path: '/auth/profile' },
  { method: 'get', path: '/workspaces/me' },
  { method: 'get', path: '/dashboard/summary' },
];

describe('Matriz RBAC de 4 roles (e2e)', () => {
  let ctx: E2eApp;
  let workspace: E2eWorkspace;

  beforeAll(async () => {
    ctx = await createE2eApp();
    workspace = await seedWorkspace(ctx, 'Rbac');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const send = (route: { method: Method; path: string; body?: Record<string, unknown> }, headers: Record<string, string>) => {
    const call = ctx.http()[route.method](route.path).set(headers);
    return route.body ? call.send(route.body) : call;
  };

  it('la tabla cubre todos los permisos de ROLE_PERMISSIONS', () => {
    const covered = new Set(ROUTES.map((route) => route.permission));
    expect([...covered].sort()).toEqual(Object.keys(ROLE_PERMISSIONS).filter((p) => p !== 'VIEW_UNMASKED_DATA').sort());
  });

  describe.each(ROUTES)('$method $path ($permission)', (route) => {
    it('sin token responde 401', async () => {
      await send(route, {}).expect(401);
    });

    it.each([...USER_ROLES])('%s', async (role: UserRole) => {
      const response = await send(route, bearer(workspace.users[role]));
      if (hasPermission(role, route.permission)) {
        expect(response.status, `${role} debería pasar el guard: ${JSON.stringify(response.body)}`).not.toBe(403);
        expect(response.status).not.toBe(401);
        expect(response.status).toBeLessThan(500);
      } else {
        expect(response.status, `${role} no debería tener ${route.permission}`).toBe(403);
        expect(response.body).toMatchObject({ statusCode: 403, message: 'No tienes permisos para realizar esta acción' });
      }
    });
  });

  describe.each(ANY_AUTHENTICATED)('$method $path (cualquier rol)', (route) => {
    it.each([...USER_ROLES])('%s', async (role: UserRole) => {
      await send(route, bearer(workspace.users[role])).expect(200);
    });
  });

  it('LECTOR solo recibe datos enmascarados: no tiene VIEW_UNMASKED_DATA', () => {
    expect(hasPermission('LECTOR', 'VIEW_UNMASKED_DATA')).toBe(false);
    expect(hasPermission('AUDITOR', 'VIEW_UNMASKED_DATA')).toBe(false);
  });

  it('un usuario no puede escalar su propio rol', async () => {
    const operador = workspace.users.OPERADOR;
    await ctx
      .http()
      .patch(`/users/${operador.id}/role`)
      .set(bearer(operador))
      .send({ role: 'ADMIN' })
      .expect(403);
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: operador.id } });
    expect(stored.role).toBe('OPERADOR');
  });

  it('un token sigue el rol actual del usuario: si el ADMIN lo baja a LECTOR, pierde permisos al instante', async () => {
    const { ADMIN, OPERADOR } = workspace.users;
    await ctx.http().get('/connections').set(bearer(OPERADOR)).expect(200);
    await ctx.http().patch(`/users/${OPERADOR.id}/role`).set(bearer(ADMIN)).send({ role: 'LECTOR' }).expect(200);
    await ctx.http().get('/connections').set(bearer(OPERADOR)).expect((response) => {
      expect([401, 403]).toContain(response.status);
    });
  });
});
