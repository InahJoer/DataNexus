import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../pagination/keyset.js';

/** Consulta de `GET /engine/connections/:id/data` (exploración paginada de una tabla o colección, RNF-06). */
export class BrowseDataQueryDto {
  @ApiProperty({ description: 'Tabla, vista o colección', example: 'clientes', maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  entidad: string;

  @ApiPropertyOptional({ description: 'Esquema SQL (si se omite: public / el de la conexión)', example: 'public' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  esquema?: string;

  @ApiPropertyOptional({ description: 'Filas por página', default: DEFAULT_PAGE_SIZE, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limite: number = DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({
    description: 'Cursor opaco devuelto en `nextCursor` de la página anterior. Sin cursor se lee la primera página.',
    maxLength: 2048,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'cursor no es válido' })
  cursor?: string;

  @ApiPropertyOptional({
    description:
      'Filtros en JSON con el mismo formato que en el cross-join (condiciones y grupos AND/OR), por ejemplo ' +
      '[{"campo":"pais","operador":"eq","valor":"NI"}]. Se aplican antes de paginar.',
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  filtros?: string;
}

export class BrowseDataResponseDto {
  @ApiProperty({ example: 'clientes' })
  entidad: string;

  @ApiPropertyOptional({ example: 'public' })
  esquema?: string;

  @ApiProperty({ example: 50 })
  limite: number;

  @ApiProperty({ type: [String], example: ['id'], description: 'Columnas por las que avanza el cursor (llave primaria, _id o id del documento)' })
  orden: string[];

  @ApiProperty({ example: 50, description: 'Filas de esta página' })
  filas: number;

  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } })
  data: Record<string, unknown>[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Cursor para pedir la página siguiente; null si es la última',
    example: 'eyJ2IjoxLCJiIjoi...',
  })
  nextCursor: string | null;
}
