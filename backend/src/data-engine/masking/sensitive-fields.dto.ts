import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export const MASKING_STRATEGIES = ['EMAIL', 'PHONE', 'FULL', 'HASH'] as const;

export class CreateSensitiveFieldDto {
  @ApiProperty({ description: 'Nombre del campo o columna (sin distinguir mayúsculas)', example: 'cedula', maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z_][A-Za-z0-9_$.-]*$/, { message: 'campo debe ser un nombre de columna válido' })
  campo: string;

  @ApiPropertyOptional({
    enum: MASKING_STRATEGIES,
    default: 'FULL',
    description: 'EMAIL: conserva el dominio · PHONE: conserva los 2 últimos dígitos · FULL: oculta todo · HASH: huella estable (permite agrupar sin revelar el valor)',
  })
  @IsOptional()
  @IsIn(MASKING_STRATEGIES)
  estrategia?: (typeof MASKING_STRATEGIES)[number];

  @ApiPropertyOptional({ description: 'Limita la regla a una conexión; sin ella aplica a todas', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  conexionId?: string;

  @ApiPropertyOptional({ description: 'Limita la regla a una tabla o colección; sin ella aplica a todas', example: 'clientes' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  entidad?: string;
}
