import { applyDecorators, SetMetadata } from '@nestjs/common';
import { rolesWith, type Permission, type UserRole } from '../interfaces/user-role.js';

export const REQUIRED_ROLES_KEY = 'required-roles';
/** Permiso de la matriz RBAC que exige el endpoint. Lo usan los tokens de acceso personal (issue #65). */
export const REQUIRED_PERMISSION_KEY = 'required-permission';

/** Restringe un endpoint a una lista explícita de roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES_KEY, roles);

/** Restringe un endpoint a los roles que poseen el permiso indicado en la matriz RBAC. */
export const RequirePermission = (permission: Permission) =>
  applyDecorators(Roles(...rolesWith(permission)), SetMetadata(REQUIRED_PERMISSION_KEY, permission));
