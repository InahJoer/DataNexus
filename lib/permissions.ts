import type { UserRole } from '@/lib/auth-context';

/**
 * Copia de la matriz RBAC del backend (backend/src/auth/interfaces/user-role.ts), limitada a los permisos que la
 * interfaz necesita para decidir qué mostrar. El backend sigue siendo quien autoriza: ocultar una sección aquí solo
 * evita que el usuario llegue a una pantalla que la API le rechazaría con 403.
 */
export const ROLE_PERMISSIONS = {
  VIEW_CONNECTIONS: ['ADMIN', 'OPERADOR'],
  MANAGE_CONNECTIONS: ['ADMIN'],
  EXPLORE_DATA: ['ADMIN', 'OPERADOR'],
  MODIFY_RECORDS: ['ADMIN', 'OPERADOR'],
  RUN_JOINS: ['ADMIN', 'OPERADOR'],
  MANAGE_REPORTS: ['ADMIN', 'OPERADOR'],
  READ_AUDIT: ['ADMIN', 'AUDITOR'],
  MANAGE_MEMBERS: ['ADMIN'],
  MANAGE_WORKSPACE: ['ADMIN'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof ROLE_PERMISSIONS;

export function hasPermission(role: UserRole | undefined, permission: Permission): boolean {
  return role !== undefined && (ROLE_PERMISSIONS[permission] as readonly UserRole[]).includes(role);
}
