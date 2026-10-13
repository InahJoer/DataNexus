import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CrossJoinDto {
  @ApiProperty({
    description: 'UUID de la conexión SQL origen',
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  })
  @IsUUID('4', { message: 'conexionSqlId debe ser un UUID v4 válido' })
  @IsNotEmpty()
  conexionSqlId: string;

  @ApiProperty({
    description: 'UUID de la conexión NoSQL origen',
    example: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e',
  })
  @IsUUID('4', { message: 'conexionNoSqlId debe ser un UUID v4 válido' })
  @IsNotEmpty()
  conexionNoSqlId: string;

  @ApiProperty({
    description: 'Nombre de la tabla SQL a consultar',
    example: 'clientes',
  })
  @IsString()
  @IsNotEmpty()
  tablaSql: string;

  @ApiProperty({
    description: 'Nombre de la colección NoSQL a consultar',
    example: 'pedidos',
  })
  @IsString()
  @IsNotEmpty()
  coleccionNoSql: string;

  @ApiProperty({
    description: 'Nombre de la llave en la tabla SQL para el Join',
    example: 'id',
  })
  @IsString()
  @IsNotEmpty()
  llaveSql: string;

  @ApiProperty({
    description: 'Nombre de la llave en la colección NoSQL para el Join',
    example: 'cliente_id',
  })
  @IsString()
  @IsNotEmpty()
  llaveNoSql: string;

  @ApiPropertyOptional({
    description: 'Límite de elementos por página',
    default: 50,
    minimum: 1,
    maximum: 1000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 50;

  @ApiPropertyOptional({
    description: 'Desplazamiento (offset) para la paginación',
    default: 0,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

export const EXPORT_FORMATS = ['excel', 'pdf', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export class ExportCrossJoinDto extends CrossJoinDto {
  @ApiProperty({
    description: 'Formato de exportación del archivo resultante',
    enum: EXPORT_FORMATS,
    example: 'excel',
  })
  @IsIn(EXPORT_FORMATS, {
    message: 'El formato debe ser uno de: excel, pdf, json',
  })
  @IsNotEmpty()
  format: ExportFormat;
}
