import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { USER_ROLES, type UserRole } from '../../auth/interfaces/user-role.js';
import { IsStrongPassword, PASSWORD_POLICY_DESCRIPTION } from '../../auth/validators/password-policy.js';

/** Estado visible de una invitación: PENDIENTE vencida se informa como EXPIRADA. */
export const INVITATION_STATES = ['PENDIENTE', 'ACEPTADA', 'REVOCADA', 'EXPIRADA'] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export class InvitationTokenDto {
  @ApiProperty({ description: 'Token recibido en el enlace del correo de invitación' })
  @IsString()
  @IsNotEmpty({ message: 'El token es requerido' })
  @Matches(TOKEN_PATTERN, { message: 'El token tiene un formato inválido' })
  token: string;
}

export class AcceptInvitationDto extends InvitationTokenDto {
  @ApiProperty({ example: 'MiClave#2026dn', description: PASSWORD_POLICY_DESCRIPTION })
  @IsStrongPassword()
  password: string;

  @ApiPropertyOptional({ description: 'Nombre a mostrar; por defecto el de la invitación', example: 'María López' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'El nombre no puede estar vacío' })
  @MaxLength(120)
  name?: string;
}

export class ListInvitationsQueryDto {
  @ApiPropertyOptional({ enum: [...INVITATION_STATES], description: 'Filtra por estado' })
  @IsOptional()
  @IsIn([...INVITATION_STATES], { message: 'El estado debe ser PENDIENTE, ACEPTADA, REVOCADA o EXPIRADA' })
  estado?: InvitationState;
}

class InvitationInviterDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  email: string;
}

export class InvitationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'nuevo.miembro@empresa.com' })
  email: string;

  @ApiProperty({ example: 'María López' })
  name: string;

  @ApiProperty({ enum: [...USER_ROLES] })
  role: UserRole;

  @ApiProperty({ enum: [...INVITATION_STATES] })
  estado: InvitationState;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;

  @ApiProperty({ type: InvitationInviterDto, nullable: true })
  invitedBy: InvitationInviterDto | null;

  @ApiPropertyOptional({
    description: 'Solo en invitar/reenviar: false si el correo no pudo enviarse (se puede reenviar).',
  })
  correoEnviado?: boolean;
}

export class InvitationPreviewDto {
  @ApiProperty()
  email: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: [...USER_ROLES] })
  role: UserRole;

  @ApiProperty({ example: 'Acme Analytics S.A.' })
  nombreEmpresa: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
}
