import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { USER_ROLES, type UserRole } from '../../auth/interfaces/user-role.js';

export class InviteUserDto {
  @ApiProperty({ description: 'Correo electrónico del nuevo miembro', example: 'nuevo.miembro@empresa.com' })
  @IsEmail({}, { message: 'El correo debe ser una dirección de email válida' })
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Nombre completo del miembro', example: 'María López' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Rol inicial del usuario dentro del workspace',
    enum: [...USER_ROLES],
    example: 'LECTOR',
  })
  @IsIn([...USER_ROLES], { message: 'El rol debe ser ADMIN, OPERADOR o LECTOR' })
  role: UserRole;

  @ApiPropertyOptional({
    description: 'Contraseña temporal inicial (mínimo 6 caracteres)',
    example: 'Temporal123!',
  })
  @IsOptional()
  @IsString()
  @MinLength(6, { message: 'La contraseña temporal debe tener al menos 6 caracteres' })
  temporaryPassword?: string;
}
