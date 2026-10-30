import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import type { UserRole } from '../users.service.js';

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
    enum: ['ADMIN', 'LECTOR'],
    example: 'LECTOR',
  })
  @IsIn(['ADMIN', 'LECTOR'], { message: 'El rol debe ser ADMIN o LECTOR' })
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
