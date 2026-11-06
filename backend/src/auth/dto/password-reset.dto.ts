import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { IsStrongPassword, PASSWORD_POLICY_DESCRIPTION } from '../validators/password-policy.js';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'admin@datanexus.demo' })
  @IsEmail({}, { message: 'El correo debe tener un formato válido' })
  @MaxLength(254)
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token recibido en el enlace del correo' })
  @IsString()
  @IsNotEmpty({ message: 'El token es requerido' })
  @Matches(/^[A-Za-z0-9_-]{20,128}$/, { message: 'El token tiene un formato inválido' })
  token: string;

  @ApiProperty({ example: 'NuevaClave#2026', description: PASSWORD_POLICY_DESCRIPTION })
  @IsStrongPassword()
  newPassword: string;
}

export class MessageResponseDto {
  @ApiProperty()
  message: string;
}
