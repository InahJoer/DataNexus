import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Max,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  JOIN_ALIAS_PATTERN,
  JOIN_TYPES,
  MAX_JOIN_KEYS,
  MAX_JOIN_SOURCES,
  MIN_JOIN_SOURCES,
  type JoinType,
} from '../join/join-plan.js';
import {
  FILTER_LOGIC,
  FILTER_OPERATORS,
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_FIELD_LENGTH,
  ROW_LIMIT_OPTIONS,
  describeFilterError,
  type FilterLogic,
  type FilterNode,
  type FilterOperator,
  type FilterValue,
  type RowLimitOption,
} from '../filters/filter-tree.js';

// Los operadores y tipos de filtro viven en filters/filter-tree.ts; se reexportan para no romper importaciones.
export {
  FILTER_OPERATORS,
  FILTER_LOGIC,
  ROW_LIMIT_OPTIONS,
  type DataFilter,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
  type FilterScalar,
  type FilterValue,
} from '../filters/filter-tree.js';

/** Valida una lista de filtros con grupos AND/OR anidados y devuelve un mensaje claro en español. */
@ValidatorConstraint({ name: 'filterList', async: false })
class FilterListConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return describeFilterError(value) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property}: ${describeFilterError(args.value) ?? 'filtros no válidos'}`;
  }
}

/** Condición sobre un campo (solo documenta el esquema; la validación la hace FilterListConstraint). */
export class DataFilterDto {
  @ApiProperty({ description: 'Campo de origen que se filtrará', example: 'status', maxLength: MAX_FILTER_FIELD_LENGTH })
  campo: string;

  @ApiProperty({ enum: FILTER_OPERATORS, example: 'eq' })
  operador: FilterOperator;

  @ApiProperty({
    description:
      'eq/neq: escalar o null · gt/gte/lt/lte: escalar · in/not-in: lista de 1 a 10 escalares · ' +
      'between: [mínimo, máximo] (números o textos, p. ej. fechas ISO) · contains/startsWith: texto (sin distinguir ' +
      'mayúsculas) · isNull: true (es nulo) o false (no es nulo)',
    example: 'active',
  })
  valor: FilterValue;
}

/** Grupo de filtros combinados con AND u OR; se puede anidar hasta 3 niveles. */
export class FilterGroupDto {
  @ApiProperty({ enum: FILTER_LOGIC, example: 'OR' })
  logica: FilterLogic;

  @ApiProperty({
    description: 'Condiciones o grupos del grupo',
    type: 'array',
    items: { oneOf: [{ $ref: getSchemaPath(DataFilterDto) }, { $ref: getSchemaPath(FilterGroupDto) }] },
  })
  filtros: FilterNode[];
}

/** Documentación OpenAPI de una lista de filtros: condiciones y grupos, combinados con AND. */
const FILTER_LIST_SCHEMA = {
  type: 'array' as const,
  items: { oneOf: [{ $ref: getSchemaPath(DataFilterDto) }, { $ref: getSchemaPath(FilterGroupDto) }] },
};

/** Decoradores comunes de una lista de filtros de una fuente. */
function FilterList(description: string): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      description: `${description}. Se combinan con AND; usa grupos { logica: 'OR', filtros: [...] } para OR. Máximo ${MAX_FILTER_CONDITIONS} condiciones.`,
      ...FILTER_LIST_SCHEMA,
    }),
    IsOptional(),
    IsArray(),
    ArrayMaxSize(MAX_FILTER_CONDITIONS),
    Validate(FilterListConstraint),
  );
}

export const AGGREGATION_OPERATIONS = ['COUNT', 'SUM', 'AVG'] as const;
export type AggregationOperation = (typeof AGGREGATION_OPERATIONS)[number];

export class AggregationMetricDto {
  @ApiProperty({ enum: AGGREGATION_OPERATIONS, example: 'SUM' })
  @IsIn(AGGREGATION_OPERATIONS)
  operation: AggregationOperation;

  @ApiPropertyOptional({
    description: 'Campo unificado sobre el que opera la métrica',
  })
  @ValidateIf(
    (metric: AggregationMetricDto) =>
      metric.operation !== 'COUNT' || metric.field !== undefined,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  field?: string;

  @ApiProperty({ description: 'Nombre del campo de salida', example: 'total' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  as: string;
}

export class JoinSourceDto {
  @ApiProperty({
    description: 'Alias único de la fuente; se usa en las relaciones y para calificar columnas repetidas',
    example: 'clientes',
    pattern: JOIN_ALIAS_PATTERN.source,
  })
  @Matches(JOIN_ALIAS_PATTERN, {
    message: 'alias debe tener de 1 a 32 letras, números o _ y empezar por letra',
  })
  alias: string;

  @ApiProperty({ description: 'UUID de la conexión', example: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d' })
  @IsUUID('4', { message: 'conexionId debe ser un UUID v4 válido' })
  conexionId: string;

  @ApiProperty({ description: 'Tabla, vista o colección de la conexión', example: 'clientes' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  entidad: string;

  @ApiPropertyOptional({ description: 'Esquema SQL de la tabla', example: 'public', maxLength: 128 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  esquema?: string;

  @FilterList('Filtros aplicados en el origen (filter pushdown cuando el motor lo admite)')
  filtros?: FilterNode[];
}

export class JoinKeyPairDto {
  @ApiProperty({ description: 'Campo de la fuente izquierda', example: 'cliente_id' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  izquierda: string;

  @ApiProperty({ description: 'Campo de la fuente derecha', example: 'cliente_ref' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  derecha: string;
}

export class JoinRelationDto {
  @ApiProperty({ description: 'Alias de una fuente ya unida', example: 'clientes' })
  @IsString()
  @IsNotEmpty()
  izquierda: string;

  @ApiProperty({ description: 'Alias de la fuente que se añade', example: 'pedidos' })
  @IsString()
  @IsNotEmpty()
  derecha: string;

  @ApiPropertyOptional({ enum: JOIN_TYPES, default: 'INNER' })
  @IsOptional()
  @IsIn(JOIN_TYPES, { message: `tipo debe ser uno de: ${JOIN_TYPES.join(', ')}` })
  tipo: JoinType = 'INNER';

  @ApiProperty({ description: `De 1 a ${MAX_JOIN_KEYS} pares de llaves (llave compuesta)`, type: [JoinKeyPairDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_JOIN_KEYS)
  @ValidateNested({ each: true })
  @Type(() => JoinKeyPairDto)
  llaves: JoinKeyPairDto[];
}

/** Los campos del formato original (una tabla SQL × una colección NoSQL) solo son obligatorios si no se envía `fuentes`. */
const usesLegacyFormat = (dto: CrossJoinDto) => dto.fuentes === undefined;

/**
 * Cross-join en memoria. Acepta dos formatos:
 * - **N fuentes** (`fuentes` + `relaciones`): de 2 a 5 tablas o colecciones de cualquier motor, con INNER, LEFT,
 *   RIGHT o FULL y llaves compuestas.
 * - **Original** (`conexionSqlId`, `tablaSql`, `conexionNoSqlId`, `coleccionNoSql`, `llaveSql`, `llaveNoSql`):
 *   se sigue aceptando igual que antes y ahora admite `tipoJoin`.
 */
@ApiExtraModels(DataFilterDto, FilterGroupDto)
export class CrossJoinDto {
  @ApiPropertyOptional({
    description: `Formato de N fuentes: de ${MIN_JOIN_SOURCES} a ${MAX_JOIN_SOURCES} tablas o colecciones`,
    type: [JoinSourceDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(MIN_JOIN_SOURCES)
  @ArrayMaxSize(MAX_JOIN_SOURCES)
  @ValidateNested({ each: true })
  @Type(() => JoinSourceDto)
  fuentes?: JoinSourceDto[];

  @ApiPropertyOptional({
    description:
      'Formato de N fuentes: una relación por cada fuente que se añade. La primera une dos fuentes y cada una de las siguientes une una fuente nueva (derecha) a una ya unida (izquierda).',
    type: [JoinRelationDto],
  })
  @ValidateIf((dto: CrossJoinDto) => dto.fuentes !== undefined)
  @IsArray()
  @ArrayMinSize(MIN_JOIN_SOURCES - 1)
  @ArrayMaxSize(MAX_JOIN_SOURCES - 1)
  @ValidateNested({ each: true })
  @Type(() => JoinRelationDto)
  relaciones?: JoinRelationDto[];

  @ApiPropertyOptional({
    description: 'Formato original: tipo de join entre la tabla SQL y la colección NoSQL',
    enum: JOIN_TYPES,
    default: 'INNER',
  })
  @IsOptional()
  @IsIn(JOIN_TYPES, { message: `tipoJoin debe ser uno de: ${JOIN_TYPES.join(', ')}` })
  tipoJoin?: JoinType;

  @ApiPropertyOptional({
    description: 'Formato original: UUID de la conexión SQL origen',
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  })
  @ValidateIf(usesLegacyFormat)
  @IsUUID('4', { message: 'conexionSqlId debe ser un UUID v4 válido' })
  @IsNotEmpty()
  conexionSqlId?: string;

  @ApiPropertyOptional({
    description: 'Formato original: UUID de la conexión NoSQL origen',
    example: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e',
  })
  @ValidateIf(usesLegacyFormat)
  @IsUUID('4', { message: 'conexionNoSqlId debe ser un UUID v4 válido' })
  @IsNotEmpty()
  conexionNoSqlId?: string;

  @ApiPropertyOptional({
    description: 'Formato original: nombre de la tabla SQL a consultar',
    example: 'clientes',
  })
  @ValidateIf(usesLegacyFormat)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  tablaSql?: string;

  @ApiPropertyOptional({
    description:
      'Esquema SQL de la tabla cuando se conoce o hay nombres duplicados',
    example: 'dbo',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  esquemaSql?: string;

  @ApiPropertyOptional({
    description: 'Formato original: nombre de la colección NoSQL a consultar',
    example: 'pedidos',
  })
  @ValidateIf(usesLegacyFormat)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  coleccionNoSql?: string;

  @ApiPropertyOptional({
    description: 'Formato original: nombre de la llave en la tabla SQL para el Join',
    example: 'id',
  })
  @ValidateIf(usesLegacyFormat)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  llaveSql?: string;

  @ApiPropertyOptional({
    description: 'Formato original: nombre de la llave en la colección NoSQL para el Join',
    example: 'cliente_id',
  })
  @ValidateIf(usesLegacyFormat)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  llaveNoSql?: string;

  @FilterList('Formato original: filtros de la tabla SQL')
  filtrosSql?: FilterNode[];

  @FilterList('Formato original: filtros de la colección NoSQL')
  filtrosNoSql?: FilterNode[];

  @ApiPropertyOptional({
    description:
      'Campos unificados usados para agrupar filas después del cross-join',
    type: [String],
    example: ['nosql.status'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(150, { each: true })
  groupBy?: string[];

  @ApiPropertyOptional({
    description: 'Métricas calculadas después del cross-join',
    type: [AggregationMetricDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AggregationMetricDto)
  aggregations?: AggregationMetricDto[];

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

  @ApiPropertyOptional({
    description:
      'Máximo de filas del resultado (RF-16). Se aplica después del join y de los filtros; `total` cuenta las filas ' +
      'conservadas y `truncado` indica si había más.',
    enum: ROW_LIMIT_OPTIONS,
    example: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(ROW_LIMIT_OPTIONS, { message: `limiteFilas debe ser uno de: ${ROW_LIMIT_OPTIONS.join(', ')}` })
  limiteFilas?: RowLimitOption;
}

export const EXPORT_FORMATS = ['excel', 'pdf', 'json', 'word'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Formatos de los reportes enviados por correo (se generan en streaming hacia el almacenamiento). */
export const REPORT_FORMATS = ['excel', 'pdf', 'word'] as const satisfies readonly ExportFormat[];
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export class ExportCrossJoinDto extends CrossJoinDto {
  @ApiProperty({
    description: 'Formato de exportación del archivo resultante',
    enum: EXPORT_FORMATS,
    example: 'excel',
  })
  @IsIn(EXPORT_FORMATS, {
    message: `El formato debe ser uno de: ${EXPORT_FORMATS.join(', ')}`,
  })
  @IsNotEmpty()
  format: ExportFormat;
}
