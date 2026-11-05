import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

  @ApiProperty({ example: 'NuevaClave2026!', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  // bcrypt ignora lo que pase de 72 bytes.
  @MaxLength(72, { message: 'La contraseña no puede superar 72 caracteres' })
  newPassword: string;
}

export class MessageResponseDto {
  @ApiProperty()
  message: string;
}
