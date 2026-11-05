import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { USER_ROLES, type UserRole } from '../../auth/interfaces/user-role.js';

export class UpdateUserRoleDto {
  @ApiProperty({ enum: [...USER_ROLES], example: 'LECTOR' })
  @IsIn([...USER_ROLES], { message: 'El rol debe ser ADMIN, OPERADOR o LECTOR' })
  role: UserRole;
}
