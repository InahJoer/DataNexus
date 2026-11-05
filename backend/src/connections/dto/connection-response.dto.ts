import { ApiProperty } from '@nestjs/swagger';
import { TIPOS_MOTOR, type TipoMotor } from '../../common/tipo-motor.js';

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
}
