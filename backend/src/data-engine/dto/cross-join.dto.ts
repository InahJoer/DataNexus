import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
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

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not-in',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type FilterScalar = string | number | boolean | null;
export type FilterValue = FilterScalar | FilterScalar[];

const isFilterScalar = (value: unknown): value is FilterScalar =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

@ValidatorConstraint({ name: 'filterValue', async: false })
class FilterValueConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const filter = args.object as DataFilterDto;
    if (value === undefined) return false;

    if (filter.operador === 'in' || filter.operador === 'not-in') {
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 10 &&
        value.every((entry) => entry !== null && isFilterScalar(entry))
      );
    }

    if (value === null) {
      return filter.operador === 'eq' || filter.operador === 'neq';
    }
    return isFilterScalar(value);
  }

  defaultMessage(args: ValidationArguments): string {
    const filter = args.object as DataFilterDto;
    if (filter.operador === 'in' || filter.operador === 'not-in') {
      return 'valor debe ser una lista de 1 a 10 valores escalares no nulos';
    }
    return 'valor debe ser un valor escalar';
  }
}

export class DataFilterDto {
  @ApiProperty({
    description: 'Campo de origen que se filtrará',
    example: 'status',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  campo: string;

  @ApiProperty({ enum: FILTER_OPERATORS, example: 'eq' })
  @IsIn(FILTER_OPERATORS)
  operador: FilterOperator;

  @ApiProperty({
    description:
      'Valor escalar; para in y not-in, lista de hasta 10 valores escalares',
    example: 'active',
  })
  @Validate(FilterValueConstraint)
  valor: FilterValue;
}

export type DataFilter = Pick<DataFilterDto, 'campo' | 'operador' | 'valor'>;

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
  @MaxLength(128)
  tablaSql: string;

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

  @ApiProperty({
    description: 'Nombre de la colección NoSQL a consultar',
    example: 'pedidos',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  coleccionNoSql: string;

  @ApiProperty({
    description: 'Nombre de la llave en la tabla SQL para el Join',
    example: 'id',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  llaveSql: string;

  @ApiProperty({
    description: 'Nombre de la llave en la colección NoSQL para el Join',
    example: 'cliente_id',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  llaveNoSql: string;

  @ApiPropertyOptional({
    description: 'Filtros SQL AND aplicados en la consulta del origen',
    type: [DataFilterDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DataFilterDto)
  filtrosSql?: DataFilterDto[];

  @ApiPropertyOptional({
    description: 'Filtros NoSQL AND aplicados en la consulta del origen',
    type: [DataFilterDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DataFilterDto)
  filtrosNoSql?: DataFilterDto[];

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
