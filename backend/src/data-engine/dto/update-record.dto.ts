import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Validate, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';
import type { JsonScalar } from '../adapters/data-source-adapter.interface.js';

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

@ValidatorConstraint({ name: 'jsonScalar', async: false })
class JsonScalarConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isJsonScalar(value);
  }

  defaultMessage(): string {
    return 'El valor debe ser un escalar JSON';
  }
}

@ValidatorConstraint({ name: 'recordKey', async: false })
class RecordKeyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value === 'string') {
      return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 1500 && !value.includes('/') && !value.includes('\0');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length > 0 &&
      entries.length <= 32 &&
      entries.every(([key, item]) => key.length > 0 && key.length <= 128 && !key.includes('\0') && isJsonScalar(item))
    );
  }

  defaultMessage(): string {
    return 'llavePrimaria debe ser un ID Firestore válido o un objeto SQL con valores escalares';
  }
}

/** Payload para cambiar una celda con control de concurrencia optimista. */
export class UpdateRecordDto {
  @ApiProperty({ format: 'uuid', example: '61d0a4cf-8b3c-4f27-8540-1c038b38c124' })
  @IsUUID('4')
  conexionId: string;

  @ApiProperty({ maxLength: 150, example: 'clientes' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  entidad: string;

  @ApiPropertyOptional({ maxLength: 128, example: 'public' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  esquema?: string;

  @ApiProperty({
    oneOf: [
      { type: 'string', example: 'documento-123' },
      { type: 'object', additionalProperties: true, example: { id: 42 } },
    ],
    description: 'ID del documento en Firestore o mapa exacto de columnas de llave primaria SQL.',
  })
  @Validate(RecordKeyConstraint)
  llavePrimaria: string | Record<string, JsonScalar>;

  @ApiProperty({ maxLength: 128, example: 'nombre' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  campo: string;

  @ApiProperty({ nullable: true, oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] })
  @Validate(JsonScalarConstraint)
  valorAnterior: JsonScalar;

  @ApiProperty({ nullable: true, oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] })
  @Validate(JsonScalarConstraint)
  valorNuevo: JsonScalar;
}
