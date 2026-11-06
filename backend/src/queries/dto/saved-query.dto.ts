import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CrossJoinDto } from '../../data-engine/dto/cross-join.dto.js';
import { PaginatedCrossJoinResultDto } from '../../data-engine/dto/cross-join-result.dto.js';

export const SAVED_QUERY_VISIBILITIES = ['PRIVADA', 'PUBLICADA'] as const;
export type SavedQueryVisibility = (typeof SAVED_QUERY_VISIBILITIES)[number];

export class CreateSavedQueryDto {
  @ApiProperty({ example: 'Ventas por cliente', maxLength: 120 })
  @IsString({ message: 'El nombre debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @MaxLength(120, { message: 'El nombre no puede superar 120 caracteres' })
  nombre: string;

  @ApiPropertyOptional({ example: 'Pedidos de MySQL cruzados con clientes de Firestore', maxLength: 500 })
  @IsOptional()
  @IsString({ message: 'La descripción debe ser un texto' })
  @MaxLength(500, { message: 'La descripción no puede superar 500 caracteres' })
  descripcion?: string;

  @ApiProperty({
    type: CrossJoinDto,
    description:
      'Definición del join: el mismo cuerpo de POST /engine/join. limit y offset no se guardan; se indican al ejecutar.',
  })
  @IsObject({ message: 'La definición debe ser un objeto' })
  @IsNotEmptyObject({}, { message: 'La definición es requerida' })
  @ValidateNested()
  @Type(() => CrossJoinDto)
  definicion: CrossJoinDto;

  @ApiPropertyOptional({
    enum: SAVED_QUERY_VISIBILITIES,
    default: 'PRIVADA',
    description: 'PRIVADA: solo ADMIN y OPERADOR. PUBLICADA: también la ve y ejecuta el LECTOR.',
  })
  @IsOptional()
  @IsIn(SAVED_QUERY_VISIBILITIES, { message: 'La visibilidad debe ser PRIVADA o PUBLICADA' })
  visibilidad?: SavedQueryVisibility;
}

export class UpdateSavedQueryDto extends PartialType(CreateSavedQueryDto) {}

export class ListSavedQueriesQueryDto {
  @ApiPropertyOptional({ enum: SAVED_QUERY_VISIBILITIES })
  @IsOptional()
  @IsIn(SAVED_QUERY_VISIBILITIES, { message: 'La visibilidad debe ser PRIVADA o PUBLICADA' })
  visibilidad?: SavedQueryVisibility;
}

export class RunSavedQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Versión de la definición a ejecutar. Por defecto la vigente. Solo ADMIN y OPERADOR.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
}

export class SavedQueryAuthorDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Pérez' })
  name: string;
}

export class SavedQueryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  nombre: string;

  @ApiProperty({ type: String, nullable: true })
  descripcion: string | null;

  @ApiProperty({
    type: CrossJoinDto,
    nullable: true,
    description: 'Definición del join. null para el LECTOR, que solo consume el resultado.',
  })
  definicion: Record<string, unknown> | null;

  @ApiProperty({ example: 3, description: 'Versión vigente de la definición.' })
  version: number;

  @ApiProperty({ enum: SAVED_QUERY_VISIBILITIES })
  visibilidad: SavedQueryVisibility;

  @ApiProperty({ type: SavedQueryAuthorDto, nullable: true })
  autor: SavedQueryAuthorDto | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

export class SavedQueryVersionDto {
  @ApiProperty({ example: 2 })
  version: number;

  @ApiProperty({ type: CrossJoinDto })
  definicion: Record<string, unknown>;

  @ApiProperty({ type: SavedQueryAuthorDto, nullable: true })
  autor: SavedQueryAuthorDto | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

export class SavedQueryRunResultDto extends PaginatedCrossJoinResultDto {
  @ApiProperty({ format: 'uuid' })
  consultaId: string;

  @ApiProperty({ example: 3, description: 'Versión de la definición que se ejecutó.' })
  version: number;
}
