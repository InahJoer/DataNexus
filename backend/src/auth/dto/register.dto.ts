import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { IsStrongPassword, PASSWORD_POLICY_DESCRIPTION } from '../validators/password-policy.js';
import { IsCorporateEmail } from '../validators/corporate-email.js';

export class RegisterDto {
  @ApiProperty({
    example: 'admin@empresa.com',
    description: 'Correo corporativo del usuario (no se aceptan Gmail, Hotmail, Outlook, etc.)',
  })
  @IsEmail({}, { message: 'El correo debe tener un formato válido' })
  @IsCorporateEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Admin User', description: 'Nombre completo del usuario' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Segura#2026dn', description: PASSWORD_POLICY_DESCRIPTION })
  @IsStrongPassword()
  password: string;

  @ApiProperty({ example: 'UUID-DEL-WORKSPACE', description: 'ID del Workspace al que pertenece el usuario' })
  @IsString()
  @IsNotEmpty()
  workspaceId: string;
}
