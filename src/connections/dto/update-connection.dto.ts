import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateConnectionDto {
  @ApiPropertyOptional({
    example: 'SQLServer',
    description: 'Tipo de motor de base de datos',
  })
  @IsOptional()
  @IsString({ message: 'El tipo de motor debe ser un texto' })
  tipoMotor?: string;

  @ApiPropertyOptional({
    example: 'sqlserver.datanexus.internal',
    description: 'Dirección o nombre de host del servidor de base de datos',
  })
  @IsOptional()
  @IsString({ message: 'El host debe ser un texto' })
  host?: string;

  @ApiPropertyOptional({
    example: 'analytics_db_v2',
    description: 'Nombre de la base de datos a conectar',
  })
  @IsOptional()
  @IsString({ message: 'El nombre de la base de datos debe ser un texto' })
  dbName?: string;

  @ApiPropertyOptional({
    example: 'Server=sqlserver.datanexus.internal;Database=analytics_db_v2;User Id=sa;Password=NewP@ssw0rd2026;',
    description: 'Nueva cadena de conexión en texto plano (será re-encriptada con AES-256)',
  })
  @IsOptional()
  @IsString({ message: 'La cadena de conexión debe ser un texto' })
  connectionString?: string;

}
