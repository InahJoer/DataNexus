export const USER_ROLES = ['ADMIN', 'OPERADOR', 'LECTOR'] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(role: string): role is UserRole {
  return (USER_ROLES as readonly string[]).includes(role);
}
