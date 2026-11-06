import { describe, expect, it } from 'vitest';
import {
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  USER_ROLES,
  hasPermission,
  isUserRole,
  type Permission,
  type UserRole,
} from './user-role.js';

/** Matriz esperada según el Dossier Técnico (sección 5, Segregación de Funciones). */
const EXPECTED: Record<Permission, UserRole[]> = {
  MANAGE_CONNECTIONS: ['ADMIN'],
  VIEW_CONNECTIONS: ['ADMIN', 'OPERADOR'],
  EXPLORE_DATA: ['ADMIN', 'OPERADOR'],
  RUN_JOINS: ['ADMIN', 'OPERADOR'],
  EXPORT_DATA: ['ADMIN', 'OPERADOR'],
  MANAGE_REPORTS: ['ADMIN', 'OPERADOR'],
  READ_AUDIT: ['ADMIN', 'AUDITOR'],
  MANAGE_MEMBERS: ['ADMIN'],
  MANAGE_WORKSPACE: ['ADMIN'],
  MANAGE_QUERIES: ['ADMIN', 'OPERADOR'],
  RUN_SAVED_QUERIES: ['ADMIN', 'OPERADOR', 'LECTOR'],
  VIEW_UNMASKED_DATA: ['ADMIN', 'OPERADOR'],
};

describe('Matriz RBAC de 4 roles', () => {
  it('define exactamente los 4 roles del dossier con etiqueta', () => {
    expect([...USER_ROLES]).toEqual(['ADMIN', 'OPERADOR', 'LECTOR', 'AUDITOR']);
    for (const role of USER_ROLES) expect(ROLE_LABELS[role]).toBeTruthy();
  });

  it('coincide con la matriz esperada para cada permiso', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const permission of Object.keys(EXPECTED) as Permission[]) {
      for (const role of USER_ROLES) {
        expect(hasPermission(role, permission), `${role} → ${permission}`).toBe(
          EXPECTED[permission].includes(role),
        );
      }
    }
  });

  it('AUDITOR solo puede leer la bitácora y no accede a datos de negocio', () => {
    const permissions = (Object.keys(ROLE_PERMISSIONS) as Permission[]).filter((p) =>
      hasPermission('AUDITOR', p),
    );
    expect(permissions).toEqual(['READ_AUDIT']);
  });

  it('LECTOR solo consume consultas publicadas: sin escritura ni datos sin enmascarar', () => {
    const permissions = (Object.keys(ROLE_PERMISSIONS) as Permission[]).filter((p) =>
      hasPermission('LECTOR', p),
    );
    expect(permissions).toEqual(['RUN_SAVED_QUERIES']);
  });

  it('rechaza roles desconocidos, en minúsculas o vacíos', () => {
    expect(isUserRole('admin')).toBe(false);
    expect(isUserRole('')).toBe(false);
    expect(isUserRole(undefined)).toBe(false);
    expect(hasPermission('SUPERADMIN', 'MANAGE_MEMBERS')).toBe(false);
    expect(hasPermission(undefined, 'READ_AUDIT')).toBe(false);
  });
});
