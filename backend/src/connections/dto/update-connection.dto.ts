import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  normalizeTipoMotor,
  TIPO_MOTOR_MESSAGE,
  TIPOS_MOTOR,
  type TipoMotor,
} from '../../common/tipo-motor.js';
import { CREDENTIALS_SCHEMA } from './create-connection.dto.js';

/**
 * Cambio parcial de una conexión. Con el mismo motor, `credenciales` puede traer solo los campos que cambian
 * (p. ej. solo `password`); al cambiar `tipoMotor` deben enviarse completas.
 */
export class UpdateConnectionDto {
  @ApiPropertyOptional({ example: 'Ventas producción', description: 'Nombre descriptivo de la conexión' })
  @IsOptional()
  @IsString({ message: 'El nombre debe ser un texto' })
  @MaxLength(120, { message: 'El nombre no puede superar 120 caracteres' })
  nombre?: string;

  @ApiPropertyOptional({
    enum: [...TIPOS_MOTOR],
    example: 'SQLSERVER',
    description: 'Nuevo motor (acepta alias). Requiere enviar `credenciales` completas.',
  })
  @IsOptional()
  @Transform(({ value }) => normalizeTipoMotor(value))
  @IsIn([...TIPOS_MOTOR], { message: TIPO_MOTOR_MESSAGE })
  tipoMotor?: TipoMotor;

  @ApiPropertyOptional({
    ...CREDENTIALS_SCHEMA,
    description: 'Credenciales nuevas o solo los campos que cambian (mismo motor). Se vuelven a cifrar.',
  })
  @IsOptional()
  @IsObject({ message: 'credenciales debe ser un objeto con los datos de conexión del motor' })
  credenciales?: Record<string, unknown>;
}
