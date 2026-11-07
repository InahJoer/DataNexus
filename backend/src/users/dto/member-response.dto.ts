import { ApiProperty } from '@nestjs/swagger';
import { USER_ROLES, type UserRole } from '../../auth/interfaces/user-role.js';

/** Miembro del workspace en la pantalla "Usuarios y permisos" (#71). */
export class MemberResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ana@acme.com' })
  email: string;

  @ApiProperty({ example: 'Ana Martínez' })
  name: string;

  @ApiProperty({ enum: [...USER_ROLES] })
  role: UserRole;

  @ApiProperty({ format: 'uuid' })
  workspaceId: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Última actividad en cualquier sesión' })
  ultimoAcceso: Date | null;

  @ApiProperty({ example: 2, description: 'Sesiones abiertas (no cerradas ni vencidas)' })
  sesionesActivas: number;

  @ApiProperty({ description: 'Cuenta bloqueada temporalmente por intentos fallidos' })
  bloqueado: boolean;

  @ApiProperty({ description: 'true si es el usuario que hace la petición' })
  esUstedMismo: boolean;
}
