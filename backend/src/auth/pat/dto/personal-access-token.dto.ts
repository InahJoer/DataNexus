import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PAT_SCOPE_NAMES, type PatScope } from '../pat-scopes.js';

export const PAT_DEFAULT_EXPIRATION_DAYS = 90;
export const PAT_MAX_EXPIRATION_DAYS = 365;

export class CreatePersonalAccessTokenDto {
  @ApiProperty({ example: 'Power BI - tablero de ventas', maxLength: 80 })
  @IsString()
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @MaxLength(80)
  nombre: string;

  @ApiProperty({ enum: PAT_SCOPE_NAMES, isArray: true, example: ['queries:read'] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Elige al menos un permiso' })
  @ArrayMaxSize(PAT_SCOPE_NAMES.length)
  @ArrayUnique()
  @IsIn(PAT_SCOPE_NAMES, { each: true, message: `Cada permiso debe ser uno de: ${PAT_SCOPE_NAMES.join(', ')}` })
  permisos: PatScope[];

  @ApiPropertyOptional({
    example: PAT_DEFAULT_EXPIRATION_DAYS,
    minimum: 1,
    maximum: PAT_MAX_EXPIRATION_DAYS,
    description: `Días de validez (por defecto ${PAT_DEFAULT_EXPIRATION_DAYS}). Todo token caduca.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAT_MAX_EXPIRATION_DAYS)
  expiraEnDias?: number;
}

export class PersonalAccessTokenDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Power BI - tablero de ventas' }) nombre: string;
  @ApiProperty({ example: 'pat_Xk3f9QaB', description: 'Inicio del token, para reconocerlo sin revelarlo.' }) prefijo: string;
  @ApiProperty({ enum: PAT_SCOPE_NAMES, isArray: true }) permisos: string[];
  @ApiProperty({ enum: ['ACTIVO', 'CADUCADO'] }) estado: 'ACTIVO' | 'CADUCADO';
  @ApiProperty() expiresAt: Date;
  @ApiPropertyOptional({ nullable: true }) lastUsedAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class CreatedPersonalAccessTokenDto extends PersonalAccessTokenDto {
  @ApiProperty({
    example: 'pat_Xk3f9QaB...',
    description: 'Token completo. Se muestra **una sola vez**: guárdalo en un lugar seguro.',
  })
  token: string;
}

export class PatScopeDto {
  @ApiProperty({ enum: PAT_SCOPE_NAMES }) permiso: PatScope;
  @ApiProperty() descripcion: string;
  @ApiProperty({ description: 'false si tu rol actual no puede conceder este permiso.' }) disponible: boolean;
}
