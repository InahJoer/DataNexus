import { ApiExtraModels, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import {
  normalizeTipoMotor,
  TIPO_MOTOR_MESSAGE,
  TIPOS_MOTOR,
  type TipoMotor,
} from '../../common/tipo-motor.js';
import {
  FirestoreCredentialsDto,
  MongoCredentialsDto,
  MysqlCredentialsDto,
  PostgresCredentialsDto,
  SqlServerCredentialsDto,
} from '../credentials/credential-dtos.js';
import { CREDENTIALS_SCHEMA } from './create-connection.dto.js';

export const MIN_CONNECTION_TEST_TIMEOUT_MS = 1_000;
export const MAX_CONNECTION_TEST_TIMEOUT_MS = 30_000;

/** Opciones comunes a ambas pruebas. */
export class ConnectionTestOptionsDto {
  @ApiPropertyOptional({
    minimum: MIN_CONNECTION_TEST_TIMEOUT_MS,
    maximum: MAX_CONNECTION_TEST_TIMEOUT_MS,
    example: 5000,
    description: 'Tiempo máximo de la prueba en milisegundos. Por defecto CONNECTION_TEST_TIMEOUT_MS (10000).',
  })
  @IsOptional()
  @IsInt({ message: 'timeoutMs debe ser un número entero' })
  @Min(MIN_CONNECTION_TEST_TIMEOUT_MS, { message: `timeoutMs debe ser al menos ${MIN_CONNECTION_TEST_TIMEOUT_MS}` })
  @Max(MAX_CONNECTION_TEST_TIMEOUT_MS, { message: `timeoutMs no puede superar ${MAX_CONNECTION_TEST_TIMEOUT_MS}` })
  timeoutMs?: number;
}

/**
 * Credenciales sin guardar, en el mismo formato estructurado que el alta (RF-08): el formulario puede
 * probar exactamente lo que después guardará. No se persisten ni se registran.
 */
@ApiExtraModels(
  PostgresCredentialsDto,
  MysqlCredentialsDto,
  SqlServerCredentialsDto,
  MongoCredentialsDto,
  FirestoreCredentialsDto,
)
export class TestConnectionDto extends ConnectionTestOptionsDto {
  @ApiProperty({
    enum: [...TIPOS_MOTOR],
    example: 'POSTGRESQL',
    description: 'Tipo de motor; define el formato de `credenciales`. Acepta los mismos alias que el alta.',
  })
  @Transform(({ value }) => normalizeTipoMotor(value))
  @IsIn([...TIPOS_MOTOR], { message: TIPO_MOTOR_MESSAGE })
  tipoMotor: TipoMotor;

  @ApiProperty({
    ...CREDENTIALS_SCHEMA,
    description: 'Las mismas credenciales que en POST /connections. Solo se usan para la prueba.',
  })
  @IsObject({ message: 'credenciales debe ser un objeto con los datos de conexión del motor' })
  credenciales: Record<string, unknown>;
}
