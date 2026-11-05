import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../interfaces/user-role.js';

export const REQUIRED_ROLES_KEY = 'required-roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES_KEY, roles);
