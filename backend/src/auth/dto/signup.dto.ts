import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsStrongPassword, PASSWORD_POLICY_DESCRIPTION } from '../validators/password-policy.js';
import { IsCorporateEmail } from '../validators/corporate-email.js';

export const ACCOUNT_TYPES = ['PERSONAL', 'ORGANIZACION'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Alta de cuenta con su workspace:
 * - PERSONAL: para una sola persona; cualquier correo; el workspace no admite miembros (se puede convertir después).
 * - ORGANIZACION: para equipos y empresas; exige correo corporativo y su dominio queda como dominio permitido para
 *   invitar al equipo.
 */
export class SignupDto {
  @ApiProperty({ enum: ACCOUNT_TYPES, example: 'ORGANIZACION' })
  @IsIn([...ACCOUNT_TYPES], { message: 'tipoCuenta debe ser PERSONAL u ORGANIZACION' })
  tipoCuenta: AccountType;

  @ApiProperty({ example: 'Ana Martínez' })
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'ana@acme.com', description: 'En organizaciones debe ser un correo corporativo' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'El correo debe tener un formato válido' })
  @ValidateIf((dto: SignupDto) => dto.tipoCuenta === 'ORGANIZACION')
  @IsCorporateEmail({ message: 'Las organizaciones necesitan un correo corporativo (no Gmail, Hotmail, Outlook…)' })
  email: string;

  @ApiProperty({ example: 'Segura#2026dn', description: PASSWORD_POLICY_DESCRIPTION })
  @IsStrongPassword()
  password: string;

  @ApiPropertyOptional({ example: 'Acme Analytics S.A.', description: 'Obligatorio en organizaciones' })
  @ValidateIf((dto: SignupDto) => dto.tipoCuenta === 'ORGANIZACION')
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la organización es obligatorio' })
  @MaxLength(120)
  nombreEmpresa?: string;

  @ApiPropertyOptional({ example: 'America/Managua', description: 'Zona horaria IANA del navegador' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  zonaHoraria?: string;
}
