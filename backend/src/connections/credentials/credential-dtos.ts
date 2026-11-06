import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Nombre de host, IPv4 o IPv6 (sin esquema, ruta ni credenciales). */
export const HOST_PATTERN =
  /^(?:(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[?[0-9A-Fa-f:]{2,39}\]?)$/;
const HOST_MESSAGE = 'El host debe ser un nombre de servidor o una IP, sin protocolo ni ruta';

/** Campos comunes de los motores SQL con usuario y contraseña. */
abstract class SqlCredentialsBase {
  @ApiProperty({ example: 'db.empresa.internal', description: 'Servidor (nombre o IP), sin protocolo' })
  @Transform(trim)
  @Matches(HOST_PATTERN, { message: HOST_MESSAGE })
  @IsString({ message: 'El host debe ser un texto' })
  host: string;

  @ApiPropertyOptional({ description: 'Puerto; si se omite se usa el del motor', example: 5432 })
  @IsOptional()
  @Max(65535, { message: 'El puerto debe estar entre 1 y 65535' })
  @Min(1, { message: 'El puerto debe estar entre 1 y 65535' })
  @IsInt({ message: 'El puerto debe ser un número entero' })
  port?: number;

  @ApiProperty({ example: 'analytics', description: 'Base de datos' })
  @Transform(trim)
  @MaxLength(128, { message: 'La base de datos no puede superar 128 caracteres' })
  @IsString({ message: 'La base de datos debe ser un texto' })
  @IsNotEmpty({ message: 'La base de datos es requerida' })
  database: string;

  @ApiProperty({ example: 'lector_bi' })
  @Transform(trim)
  @MaxLength(128, { message: 'El usuario no puede superar 128 caracteres' })
  @IsString({ message: 'El usuario debe ser un texto' })
  @IsNotEmpty({ message: 'El usuario es requerido' })
  username: string;

  @ApiProperty({ example: 'S3creta#2026', description: 'Se cifra con AES-256 y nunca se devuelve' })
  @MaxLength(1024, { message: 'La contraseña no puede superar 1024 caracteres' })
  @IsString({ message: 'La contraseña debe ser un texto' })
  @IsNotEmpty({ message: 'La contraseña es requerida' })
  password: string;
}

export class PostgresCredentialsDto extends SqlCredentialsBase {
  @ApiPropertyOptional({ default: false, description: 'Exigir TLS (sslmode=require)' })
  @IsOptional()
  @IsBoolean({ message: 'ssl debe ser verdadero o falso' })
  ssl?: boolean;
}

export class MysqlCredentialsDto extends SqlCredentialsBase {
  @ApiPropertyOptional({ default: false, description: 'Conectar con TLS' })
  @IsOptional()
  @IsBoolean({ message: 'ssl debe ser verdadero o falso' })
  ssl?: boolean;
}

export class SqlServerCredentialsDto extends SqlCredentialsBase {
  @ApiPropertyOptional({ default: true, description: 'Cifrar la conexión (Encrypt)' })
  @IsOptional()
  @IsBoolean({ message: 'encrypt debe ser verdadero o falso' })
  encrypt?: boolean;

  @ApiPropertyOptional({ default: false, description: 'Aceptar certificados no verificados (solo desarrollo)' })
  @IsOptional()
  @IsBoolean({ message: 'trustServerCertificate debe ser verdadero o falso' })
  trustServerCertificate?: boolean;
}

export class MongoCredentialsDto {
  @ApiProperty({
    example: 'mongodb+srv://lector:S3creta@cluster0.mongodb.net/?retryWrites=true',
    description: 'URI de conexión mongodb:// o mongodb+srv://. Se cifra y nunca se devuelve.',
  })
  @Transform(trim)
  @MaxLength(2048, { message: 'La URI no puede superar 2048 caracteres' })
  @Matches(/^mongodb(\+srv)?:\/\/[^\s]+$/, { message: 'La URI debe empezar por mongodb:// o mongodb+srv://' })
  @IsString({ message: 'La URI debe ser un texto' })
  uri: string;

  @ApiProperty({ example: 'ventas' })
  @Transform(trim)
  @MaxLength(64, { message: 'La base de datos no puede superar 64 caracteres' })
  @IsString({ message: 'La base de datos debe ser un texto' })
  @IsNotEmpty({ message: 'La base de datos es requerida' })
  database: string;
}

export class FirestoreCredentialsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Contenido del JSON de Service Account de Firebase (type, project_id, private_key, client_email...). También puede subirse como archivo en POST /connections/firestore.',
  })
  @IsObject({ message: 'serviceAccount debe ser el objeto JSON de la cuenta de servicio' })
  serviceAccount: Record<string, unknown>;

  @ApiPropertyOptional({ default: '(default)', example: '(default)', description: 'Base de datos de Firestore' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^(\(default\)|[a-z][a-z0-9-]{2,62})$/, {
    message: 'databaseId debe ser "(default)" o un identificador de Firestore válido',
  })
  databaseId?: string;
}
