import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  normalizeTipoMotor,
  TIPO_MOTOR_MESSAGE,
  TIPOS_MOTOR,
  type TipoMotor,
} from '../../common/tipo-motor.js';

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

/** Credenciales sin guardar. No se persisten ni se registran. */
export class TestConnectionDto extends ConnectionTestOptionsDto {
  @ApiProperty({
    enum: [...TIPOS_MOTOR],
    example: 'POSTGRESQL',
    description: 'Tipo de motor. Acepta los mismos alias que el alta de conexiones.',
  })
  @Transform(({ value }) => normalizeTipoMotor(value))
  @IsIn([...TIPOS_MOTOR], { message: TIPO_MOTOR_MESSAGE })
  tipoMotor: TipoMotor;

  @ApiPropertyOptional({ example: 'db.internal', description: 'Informativo; la prueba usa la cadena de conexión.' })
  @IsOptional()
  @IsString({ message: 'El host debe ser un texto' })
  @MaxLength(255, { message: 'El host no puede superar 255 caracteres' })
  host?: string;

  @ApiProperty({ example: 'analytics', description: 'Base de datos (o base de Firestore) a validar' })
  @IsString({ message: 'El nombre de la base de datos debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre de la base de datos es requerido' })
  dbName: string;

  @ApiProperty({
    example: 'postgres://user:secret@db.internal:5432/analytics',
    description:
      'PostgreSQL/MySQL: URL; SQL Server: cadena ADO.NET; Firestore: JSON de la cuenta de servicio. Solo se usa para la prueba.',
  })
  @IsString({ message: 'La cadena de conexión debe ser un texto' })
  @IsNotEmpty({ message: 'La cadena de conexión es requerida' })
  connectionString: string;
}
