import { ApiExtraModels, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
} from 'class-validator';
import type { FilterNode } from '../filters/filter-tree.js';
import {
  ColumnAliasesConstraint,
  DataFilterDto,
  EXPORT_FORMATS,
  FilterGroupDto,
  FilterList,
  SortSpecDto,
  type ExportFormat,
} from './cross-join.dto.js';

/** Máximo de filas por archivo al exportar una tabla o colección desde el explorador. */
export const MAX_DATA_EXPORT_ROWS = 10_000;

/**
 * Exportación de una tabla o colección desde el explorador de datos (`POST /engine/export/data`): los mismos
 * filtros que la vista, el orden y las columnas visibles (con su alias), en Excel, CSV, PDF, JSON o Word.
 */
@ApiExtraModels(DataFilterDto, FilterGroupDto)
export class ExportDataDto {
  @ApiProperty({ description: 'Conexión del workspace', format: 'uuid' })
  @IsUUID('4')
  conexionId: string;

  @ApiProperty({ description: 'Tabla, vista o colección', example: 'clientes', maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  entidad: string;

  @ApiPropertyOptional({ description: 'Esquema SQL o base de datos', example: 'public' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  esquema?: string;

  @FilterList('Filtros de la vista (los mismos que en el explorador)')
  filtros?: FilterNode[];

  @ApiPropertyOptional({ description: 'Orden de las filas exportadas', type: [SortSpecDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => SortSpecDto)
  ordenarPor?: SortSpecDto[];

  @ApiPropertyOptional({ description: 'Columnas visibles en orden; sin lista se exportan todas', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(300, { each: true })
  columnas?: string[];

  @ApiPropertyOptional({
    description: 'Encabezados personalizados por columna',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  @Validate(ColumnAliasesConstraint)
  aliasColumnas?: Record<string, string>;

  @ApiProperty({ enum: EXPORT_FORMATS, example: 'excel' })
  @IsIn(EXPORT_FORMATS, { message: `El formato debe ser uno de: ${EXPORT_FORMATS.join(', ')}` })
  format: ExportFormat;

  @ApiPropertyOptional({
    description: `Máximo de filas del archivo (1 a ${MAX_DATA_EXPORT_ROWS})`,
    default: MAX_DATA_EXPORT_ROWS,
    minimum: 1,
    maximum: MAX_DATA_EXPORT_ROWS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DATA_EXPORT_ROWS)
  limiteFilas?: number;
}
