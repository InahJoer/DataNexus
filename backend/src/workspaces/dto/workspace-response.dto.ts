import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { USER_ROLES, type UserRole } from '../../auth/interfaces/user-role.js';
import { TIPOS_MOTOR, type TipoMotor } from '../../common/tipo-motor.js';

export class WorkspaceSettingsDto {
  @ApiProperty({ type: [String], example: ['acme.com'] })
  dominiosPermitidos: string[];

  @ApiProperty({ type: [String], example: ['cedula', 'salario'] })
  camposSensibles: string[];
}

export class WorkspaceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Acme Analytics S.A.' })
  nombreEmpresa: string;

  @ApiProperty({ enum: ['PERSONAL', 'ORGANIZACION'], description: 'Personal (una persona) u organización (equipo).' })
  tipoCuenta: 'PERSONAL' | 'ORGANIZACION';

  @ApiProperty({ type: String, nullable: true, example: 'Datos de ventas y logística' })
  descripcion: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'https://cdn.acme.com/logo.png' })
  logoUrl: string | null;

  @ApiProperty({ example: 'America/Managua' })
  zonaHoraria: string;

  @ApiProperty({ type: String, format: 'date-time' })
  fechaCreacion: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  fechaActualizacion: Date;

  @ApiPropertyOptional({
    type: WorkspaceSettingsDto,
    description: 'Configuración del workspace. Solo se incluye para el rol ADMIN.',
  })
  configuracion?: WorkspaceSettingsDto;
}

export class WorkspaceStatsDto {
  @ApiProperty({
    example: { total: 4, porRol: { ADMIN: 1, OPERADOR: 1, LECTOR: 1, AUDITOR: 1 } },
    description: `Miembros del workspace en total y por rol (${USER_ROLES.join(', ')}).`,
  })
  miembros: { total: number; porRol: Record<UserRole, number> };

  @ApiProperty({
    example: { total: 2, porMotor: { POSTGRESQL: 1, MYSQL: 0, SQLSERVER: 0, FIRESTORE: 1, MONGODB: 0 } },
    description: `Conexiones registradas en total y por motor (${TIPOS_MOTOR.join(', ')}).`,
  })
  conexiones: { total: number; porMotor: Record<TipoMotor, number> };

  @ApiProperty({
    example: { enviados: 12, ultimoEnvio: '2026-11-05T06:00:00.000Z' },
    description: 'Reportes generados y enviados con éxito, según la bitácora de auditoría.',
  })
  reportes: { enviados: number; ultimoEnvio: Date | null };
}
