import { ApiProperty } from '@nestjs/swagger';
import { TIPOS_MOTOR, type TipoMotor } from '../../common/tipo-motor.js';

export const CREDENTIAL_FORMATS = ['ESTRUCTURADO', 'LEGADO'] as const;
export type CredentialFormat = (typeof CREDENTIAL_FORMATS)[number];

export class ConnectionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, nullable: true, example: 'Ventas producción' })
  nombre: string | null;

  @ApiProperty({ enum: [...TIPOS_MOTOR], example: 'POSTGRESQL' })
  tipoMotor: TipoMotor;

  @ApiProperty({ example: 'db.internal' })
  host: string;

  @ApiProperty({ example: 'analytics' })
  dbName: string;

  @ApiProperty({ format: 'uuid' })
  workspaceId: string;

  @ApiProperty({
    enum: [...CREDENTIAL_FORMATS],
    description: 'LEGADO = cadena de conexión libre anterior a RF-08; conviene volver a guardar sus credenciales.',
  })
  formatoCredenciales: CredentialFormat;

  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    example: { puerto: 5432, usuario: 'lector_bi', ssl: true },
    description:
      'Metadatos no secretos (puerto, usuario, ssl, projectId, clientEmail...). Nunca incluye contraseñas ni claves.',
  })
  detalles: Record<string, string | number | boolean> | null;
}
