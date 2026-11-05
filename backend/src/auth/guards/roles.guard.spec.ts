import { describe, expect, it } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';
import { RequirePermission, Roles } from '../decorators/roles.decorator.js';
import type { UserRole } from '../interfaces/user-role.js';

class TestController {
  @RequirePermission('READ_AUDIT')
  readAudit() {}

  @RequirePermission('MANAGE_MEMBERS')
  manageMembers() {}

  @Roles('LECTOR')
  lectorOnly() {}

  open() {}
}

const guard = new RolesGuard(new Reflector());

function contextFor(handler: keyof TestController, role?: UserRole | string): ExecutionContext {
  return {
    getHandler: () => TestController.prototype[handler],
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { id: 'u1', role, workspaceId: 'ws-1' } : undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('permite READ_AUDIT a ADMIN y AUDITOR', () => {
    expect(guard.canActivate(contextFor('readAudit', 'ADMIN'))).toBe(true);
    expect(guard.canActivate(contextFor('readAudit', 'AUDITOR'))).toBe(true);
  });

  it('niega READ_AUDIT a OPERADOR y LECTOR con 403', () => {
    expect(() => guard.canActivate(contextFor('readAudit', 'OPERADOR'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor('readAudit', 'LECTOR'))).toThrow(ForbiddenException);
  });

  it('solo ADMIN gestiona miembros', () => {
    expect(guard.canActivate(contextFor('manageMembers', 'ADMIN'))).toBe(true);
    for (const role of ['OPERADOR', 'LECTOR', 'AUDITOR']) {
      expect(() => guard.canActivate(contextFor('manageMembers', role))).toThrow(ForbiddenException);
    }
  });

  it('respeta listas explícitas con @Roles', () => {
    expect(guard.canActivate(contextFor('lectorOnly', 'LECTOR'))).toBe(true);
    expect(() => guard.canActivate(contextFor('lectorOnly', 'ADMIN'))).toThrow(ForbiddenException);
  });

  it('rechaza peticiones sin usuario autenticado en rutas protegidas', () => {
    expect(() => guard.canActivate(contextFor('readAudit'))).toThrow(ForbiddenException);
  });

  it('deja pasar rutas sin metadatos de rol', () => {
    expect(guard.canActivate(contextFor('open', 'LECTOR'))).toBe(true);
  });
});
