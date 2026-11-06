import { ApiProperty } from '@nestjs/swagger';
import {
  CONNECTION_ERROR_CODES,
  type ConnectionErrorCode,
} from '../testing/connection-error.normalizer.js';

export class ConnectionTestErrorDto {
  @ApiProperty({ enum: [...CONNECTION_ERROR_CODES], example: 'AUTH_FAILED' })
  code: ConnectionErrorCode;

  @ApiProperty({ example: 'Usuario o contraseña incorrectos.' })
  message: string;
}

export class ConnectionTestResultDto {
  @ApiProperty({ description: 'true si el servidor respondió con las credenciales y la base indicadas.' })
  ok: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 42,
    description: 'Milisegundos para conectar, autenticar y consultar la versión. null si la prueba falló.',
  })
  latencyMs: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'PostgreSQL 16.2' })
  serverVersion: string | null;

  @ApiProperty({
    type: ConnectionTestErrorDto,
    nullable: true,
    description: 'Error normalizado por motor; nunca incluye el mensaje original del driver.',
  })
  error: ConnectionTestErrorDto | null;
}
