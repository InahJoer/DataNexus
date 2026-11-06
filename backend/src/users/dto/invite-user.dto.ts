import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { IsStrongPassword, PASSWORD_POLICY_DESCRIPTION } from '../../auth/validators/password-policy.js';
import { IsCorporateEmail } from '../../auth/validators/corporate-email.js';
import { USER_ROLES, type UserRole } from '../../auth/interfaces/user-role.js';

export class InviteUserDto {
  @ApiProperty({ description: 'Correo electrónico del nuevo miembro', example: 'nuevo.miembro@empresa.com' })
  @IsEmail({}, { message: 'El correo debe ser una dirección de email válida' })
  @IsCorporateEmail()
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
  @IsIn([...USER_ROLES], { message: 'El rol debe ser ADMIN, OPERADOR, LECTOR o AUDITOR' })
  role: UserRole;

  @ApiPropertyOptional({
    description: `Contraseña temporal inicial. ${PASSWORD_POLICY_DESCRIPTION}`,
    example: 'Temporal#2026dn',
  })
  @IsOptional()
  @IsStrongPassword()
  temporaryPassword?: string;
}
