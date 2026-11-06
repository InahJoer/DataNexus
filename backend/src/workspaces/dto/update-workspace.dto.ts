import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateIf,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import {
  MAX_ALLOWED_DOMAINS,
  MAX_SENSITIVE_FIELDS,
  isValidTimeZone,
} from '../workspace-settings.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Decorador de class-validator: exige una zona horaria IANA válida. */
function IsTimeZone(options: ValidationOptions = {}) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isTimeZone',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isValidTimeZone(value),
        defaultMessage: () => 'La zona horaria debe ser un identificador IANA válido, por ejemplo America/Managua',
      },
    });
  };
}

/**
 * Cambios parciales del workspace (PATCH). Solo se modifican los campos enviados.
 * `logoUrl: null` elimina el logo; el resto de campos no admite null.
 */
export class UpdateWorkspaceDto {
  @ApiPropertyOptional({ description: 'Nombre de la empresa o espacio de trabajo', example: 'Acme Analytics S.A.' })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsString({ message: 'El nombre debe ser un texto' })
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(120, { message: 'El nombre no puede superar 120 caracteres' })
  nombreEmpresa?: string;

  @ApiPropertyOptional({
    description: 'URL https del logo. Envía null para eliminarlo.',
    example: 'https://cdn.acme.com/logo.png',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @Transform(trim)
  @IsUrl(
    { protocols: ['https'], require_protocol: true, require_tld: true },
    { message: 'El logo debe ser una URL https válida' },
  )
  @MaxLength(2048, { message: 'La URL del logo no puede superar 2048 caracteres' })
  logoUrl?: string | null;

  @ApiPropertyOptional({ description: 'Zona horaria IANA', example: 'America/Managua' })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsTimeZone()
  zonaHoraria?: string;

  @ApiPropertyOptional({
    description: `Dominios de correo admitidos al invitar miembros (máximo ${MAX_ALLOWED_DOMAINS}). Lista vacía = sin restricción.`,
    example: ['acme.com', 'acme.com.ni'],
    type: [String],
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: 'dominiosPermitidos debe ser una lista' })
  @ArrayMaxSize(MAX_ALLOWED_DOMAINS, { message: `Se admiten como máximo ${MAX_ALLOWED_DOMAINS} dominios` })
  @IsString({ each: true, message: 'Cada dominio debe ser un texto' })
  dominiosPermitidos?: string[];

  @ApiPropertyOptional({
    description: `Campos sensibles por defecto del workspace (máximo ${MAX_SENSITIVE_FIELDS}).`,
    example: ['cedula', 'salario', 'cliente.email'],
    type: [String],
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: 'camposSensibles debe ser una lista' })
  @ArrayMaxSize(MAX_SENSITIVE_FIELDS, { message: `Se admiten como máximo ${MAX_SENSITIVE_FIELDS} campos sensibles` })
  @IsString({ each: true, message: 'Cada campo sensible debe ser un texto' })
  camposSensibles?: string[];
}
