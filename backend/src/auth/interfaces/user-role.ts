/**
 * Matriz RBAC de 4 roles definida en el Dossier Técnico (sección 5):
 * - ADMIN (Administrador): control total de infraestructura, conexiones y miembros.
 * - OPERADOR (Analista BI): construye/ejecuta Cross-Joins, exporta y programa reportes.
 * - LECTOR: consume datos con enmascaramiento automático, sin permisos de edición.
 * - AUDITOR (Auditor de TI): solo lectura de la bitácora de auditoría, sin datos de negocio.
 */
export const USER_ROLES = ['ADMIN', 'OPERADOR', 'LECTOR', 'AUDITOR'] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  ADMIN: 'Administrador',
  OPERADOR: 'Operador (Analista BI)',
  LECTOR: 'Lector',
  AUDITOR: 'Auditor de TI',
};

/**
 * Permisos de la plataforma y los roles que los poseen.
 * Es la única fuente de verdad: controladores (@Roles) y servicios (hasPermission)
 * consultan esta tabla en lugar de comparar strings de rol sueltos.
 */
export const ROLE_PERMISSIONS = {
  /** Crear, editar y eliminar conexiones externas. */
  MANAGE_CONNECTIONS: ['ADMIN'],
  /** Listar conexiones y consultar su salud. */
  VIEW_CONNECTIONS: ['ADMIN', 'OPERADOR'],
  /** Explorar esquemas, tablas y campos de las fuentes externas. */
  EXPLORE_DATA: ['ADMIN', 'OPERADOR'],
  /** Ejecutar Cross-Joins. */
  RUN_JOINS: ['ADMIN', 'OPERADOR'],
  /** Exportar resultados a archivos. */
  EXPORT_DATA: ['ADMIN', 'OPERADOR'],
  /** Disparar y programar reportes automáticos. */
  MANAGE_REPORTS: ['ADMIN', 'OPERADOR'],
  /** Consultar la bitácora de auditoría. */
  READ_AUDIT: ['ADMIN', 'AUDITOR'],
  /** Invitar miembros y cambiar roles. */
  MANAGE_MEMBERS: ['ADMIN'],
  /** Editar nombre, logo, zona horaria y configuración del workspace (RF-05). */
  MANAGE_WORKSPACE: ['ADMIN'],
  /** Recibir datos de negocio sin enmascarar. El resto de roles siempre recibe datos enmascarados. */
  VIEW_UNMASKED_DATA: ['ADMIN', 'OPERADOR'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof ROLE_PERMISSIONS;

export function isUserRole(role: unknown): role is UserRole {
  return typeof role === 'string' && (USER_ROLES as readonly string[]).includes(role);
}

export function rolesWith(permission: Permission): readonly UserRole[] {
  return ROLE_PERMISSIONS[permission];
}

export function hasPermission(role: unknown, permission: Permission): boolean {
  return isUserRole(role) && (ROLE_PERMISSIONS[permission] as readonly UserRole[]).includes(role);
}
