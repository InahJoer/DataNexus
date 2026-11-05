import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  normalizeTipoMotor,
  TIPO_MOTOR_MESSAGE,
  TIPOS_MOTOR,
  type TipoMotor,
} from '../../common/tipo-motor.js';

export class CreateConnectionDto {
  @ApiPropertyOptional({
    example: 'Ventas producción',
    description: 'Nombre descriptivo de la conexión',
  })
  @IsOptional()
  @IsString({ message: 'El nombre debe ser un texto' })
  @MaxLength(120, { message: 'El nombre no puede superar 120 caracteres' })
  nombre?: string;

  @ApiProperty({
    enum: [...TIPOS_MOTOR],
    example: 'SQLSERVER',
    description:
      'Tipo de motor. Se aceptan alias como "SQL Server", "Firebase" o "postgres", que se normalizan al valor canónico.',
  })
  @Transform(({ value }) => normalizeTipoMotor(value))
  @IsIn([...TIPOS_MOTOR], { message: TIPO_MOTOR_MESSAGE })
  tipoMotor: TipoMotor;

  @ApiProperty({
    example: 'sqlserver.datanexus.internal',
    description: 'Dirección o nombre de host del servidor de base de datos',
  })
  @IsString({ message: 'El host debe ser un texto' })
  @IsNotEmpty({ message: 'El host es requerido' })
  host: string;

  @ApiProperty({
    example: 'analytics_db',
    description: 'Nombre de la base de datos a conectar',
  })
  @IsString({ message: 'El nombre de la base de datos debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre de la base de datos es requerido' })
  dbName: string;

  @ApiProperty({
    example: 'Server=sqlserver.datanexus.internal;Database=analytics_db;User Id=sa;Password=P@ssw0rd2026;',
    description: 'Cadena de conexión o credenciales en texto plano (serán encriptadas con AES-256 antes de guardarse)',
  })
  @IsString({ message: 'La cadena de conexión debe ser un texto' })
  @IsNotEmpty({ message: 'La cadena de conexión es requerida' })
  connectionString: string;
}
