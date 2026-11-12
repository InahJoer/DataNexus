import { hasPermission, type Permission, type UserRole } from '../interfaces/user-role.js';

/** Prefijo de los tokens de acceso personal: permite distinguirlos de un JWT en la cabecera Authorization. */
export const PAT_PREFIX = 'pat_';

/**
 * Alcances que puede tener un token de acceso personal (issue #65) y los permisos de la matriz RBAC que conceden.
 * Son solo de lectura o ejecución: un token de integración nunca gestiona conexiones, miembros, consultas
 * ni edita registros, aunque su dueño sea ADMIN.
 */
export const PAT_SCOPES = {
  /** Listar, ver y ejecutar consultas guardadas (el caso de uso de BI). */
  'queries:read': ['RUN_SAVED_QUERIES'],
  /** Ejecutar cross-joins y explorar tablas y colecciones. */
  'results:read': ['RUN_JOINS', 'EXPLORE_DATA'],
  /** Descargar resultados como archivo (Excel, CSV, PDF, JSON, Word). */
  'exports:create': ['EXPORT_DATA'],
  /** Listar conexiones y su estado de salud. */
  'connections:read': ['VIEW_CONNECTIONS'],
  /** Consultar la bitácora de auditoría (SIEM, cumplimiento). */
  'audit:read': ['READ_AUDIT'],
} as const satisfies Record<string, readonly Permission[]>;

export type PatScope = keyof typeof PAT_SCOPES;

export const PAT_SCOPE_NAMES = Object.keys(PAT_SCOPES) as PatScope[];

export const PAT_SCOPE_DESCRIPTIONS: Readonly<Record<PatScope, string>> = {
  'queries:read': 'Listar y ejecutar consultas guardadas',
  'results:read': 'Ejecutar cross-joins y explorar datos',
  'exports:create': 'Exportar resultados a archivo',
  'connections:read': 'Ver conexiones y su estado',
  'audit:read': 'Consultar la bitácora de auditoría',
};

export function isPatScope(value: unknown): value is PatScope {
  return typeof value === 'string' && value in PAT_SCOPES;
}

/** Permisos que conceden los alcances indicados (sin repetir). */
export function permissionsOfScopes(scopes: readonly string[]): Permission[] {
  const permissions = new Set<Permission>();
  for (const scope of scopes) if (isPatScope(scope)) for (const permission of PAT_SCOPES[scope]) permissions.add(permission);
  return [...permissions];
}

/** Un rol puede emitir un alcance solo si tiene todos los permisos que concede. */
export function roleCanGrantScope(role: UserRole, scope: PatScope): boolean {
  return PAT_SCOPES[scope].every((permission) => hasPermission(role, permission));
}

export function scopesForRole(role: UserRole): PatScope[] {
  return PAT_SCOPE_NAMES.filter((scope) => roleCanGrantScope(role, scope));
}
