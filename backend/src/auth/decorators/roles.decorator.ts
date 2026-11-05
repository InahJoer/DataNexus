import { SetMetadata } from '@nestjs/common';
import { rolesWith, type Permission, type UserRole } from '../interfaces/user-role.js';

export const REQUIRED_ROLES_KEY = 'required-roles';

/** Restringe un endpoint a una lista explícita de roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES_KEY, roles);

/** Restringe un endpoint a los roles que poseen el permiso indicado en la matriz RBAC. */
export const RequirePermission = (permission: Permission) => Roles(...rolesWith(permission));
