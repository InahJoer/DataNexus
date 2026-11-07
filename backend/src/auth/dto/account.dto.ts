import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword, PASSWORD_POLICY_DESCRIPTION } from '../validators/password-policy.js';

export class UpdateProfileDto {
  @ApiProperty({ example: 'Ana Martínez López', description: 'Nombre y apellidos. El correo no se edita: se usa para entrar.' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(120, { message: 'El nombre no puede superar 120 caracteres' })
  name: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: 'Contraseña actual' })
  @IsString()
  @IsNotEmpty({ message: 'Escribe tu contraseña actual' })
  currentPassword: string;

  @ApiProperty({ example: 'NuevaClave#2026', description: PASSWORD_POLICY_DESCRIPTION })
  @IsStrongPassword()
  newPassword: string;
}

export class SessionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  lastActivityAt: Date;

  @ApiProperty({ type: String, nullable: true, example: '192.0.2.10' })
  ipAddress: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' })
  userAgent: string | null;

  @ApiProperty({ description: 'true si es la sesión desde la que se hace la petición' })
  actual: boolean;
}

export class RevokedSessionsDto {
  @ApiProperty({ example: 3, description: 'Sesiones cerradas' })
  revocadas: number;
}
