import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
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

export const CREDENTIALS_SCHEMA = {
  oneOf: [
    { $ref: getSchemaPath(PostgresCredentialsDto) },
    { $ref: getSchemaPath(MysqlCredentialsDto) },
    { $ref: getSchemaPath(SqlServerCredentialsDto) },
    { $ref: getSchemaPath(MongoCredentialsDto) },
    { $ref: getSchemaPath(FirestoreCredentialsDto) },
  ],
};

/**
 * Alta de conexión con credenciales estructuradas (RF-08/RF-09). `credenciales` se valida contra el DTO
 * del motor indicado en `tipoMotor` (unión discriminada): campos extra o faltantes devuelven 400.
 */
@ApiExtraModels(
  PostgresCredentialsDto,
  MysqlCredentialsDto,
  SqlServerCredentialsDto,
  MongoCredentialsDto,
  FirestoreCredentialsDto,
)
export class CreateConnectionDto {
  @ApiPropertyOptional({ example: 'Ventas producción', description: 'Nombre descriptivo de la conexión' })
  @IsOptional()
  @IsString({ message: 'El nombre debe ser un texto' })
  @MaxLength(120, { message: 'El nombre no puede superar 120 caracteres' })
  nombre?: string;

  @ApiProperty({
    enum: [...TIPOS_MOTOR],
    example: 'POSTGRESQL',
    description:
      'Tipo de motor; define el formato de `credenciales`. Se aceptan alias como "SQL Server", "Firebase" o "postgres".',
  })
  @Transform(({ value }) => normalizeTipoMotor(value))
  @IsIn([...TIPOS_MOTOR], { message: TIPO_MOTOR_MESSAGE })
  tipoMotor: TipoMotor;

  @ApiProperty({
    ...CREDENTIALS_SCHEMA,
    description:
      'Credenciales según el motor: POSTGRESQL/MYSQL (host, port, database, username, password, ssl), SQLSERVER (host, port, database, username, password, encrypt, trustServerCertificate), MONGODB (uri, database) o FIRESTORE (serviceAccount, databaseId). Se cifran con AES-256 y nunca se devuelven.',
  })
  @IsObject({ message: 'credenciales debe ser un objeto con los datos de conexión del motor' })
  credenciales: Record<string, unknown>;
}
