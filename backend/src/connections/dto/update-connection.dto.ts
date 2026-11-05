import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  normalizeTipoMotor,
  TIPO_MOTOR_MESSAGE,
  TIPOS_MOTOR,
  type TipoMotor,
} from '../../common/tipo-motor.js';

export class UpdateConnectionDto {
  @ApiPropertyOptional({
    example: 'Ventas producción',
    description: 'Nombre descriptivo de la conexión',
  })
  @IsOptional()
  @IsString({ message: 'El nombre debe ser un texto' })
  @MaxLength(120, { message: 'El nombre no puede superar 120 caracteres' })
  nombre?: string;

  @ApiPropertyOptional({
    enum: [...TIPOS_MOTOR],
    example: 'SQLSERVER',
    description: 'Tipo de motor de base de datos (acepta alias que se normalizan)',
  })
  @IsOptional()
  @Transform(({ value }) => normalizeTipoMotor(value))
  @IsIn([...TIPOS_MOTOR], { message: TIPO_MOTOR_MESSAGE })
  tipoMotor?: TipoMotor;

  @ApiPropertyOptional({
    example: 'sqlserver.datanexus.internal',
    description: 'Dirección o nombre de host del servidor de base de datos',
  })
  @IsOptional()
  @IsString({ message: 'El host debe ser un texto' })
  host?: string;

  @ApiPropertyOptional({
    example: 'analytics_db_v2',
    description: 'Nombre de la base de datos a conectar',
  })
  @IsOptional()
  @IsString({ message: 'El nombre de la base de datos debe ser un texto' })
  dbName?: string;

  @ApiPropertyOptional({
    example: 'Server=sqlserver.datanexus.internal;Database=analytics_db_v2;User Id=sa;Password=NewP@ssw0rd2026;',
    description: 'Nueva cadena de conexión en texto plano (será re-encriptada con AES-256)',
  })
  @IsOptional()
  @IsString({ message: 'La cadena de conexión debe ser un texto' })
  connectionString?: string;

}
