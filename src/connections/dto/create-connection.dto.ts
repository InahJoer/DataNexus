import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateConnectionDto {
  @ApiProperty({
    example: 'SQLServer',
    description: 'Tipo de motor de base de datos (ej. SQLServer, Firebase, PostgreSQL, MySQL)',
  })
  @IsString({ message: 'El tipo de motor debe ser un texto' })
  @IsNotEmpty({ message: 'El tipo de motor es requerido' })
  tipoMotor: string;

  @ApiProperty({
    example: 'sqlserver.datanexus.internal',
    description: 'Dirección o nombre de host del servidor de base de datos',
  })
  @IsString({ message: 'El host debe ser un texto' })
  @IsNotEmpty({ message: 'El host es requerido' })
  host: string;

  @ApiProperty({
    example: 'analytics_db',
    description: 'Nombre de la base de datos a conectar',
  })
  @IsString({ message: 'El nombre de la base de datos debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre de la base de datos es requerido' })
  dbName: string;

  @ApiProperty({
    example: 'Server=sqlserver.datanexus.internal;Database=analytics_db;User Id=sa;Password=P@ssw0rd2026;',
    description: 'Cadena de conexión o credenciales en texto plano (serán encriptadas con AES-256 antes de guardarse)',
  })
  @IsString({ message: 'La cadena de conexión debe ser un texto' })
  @IsNotEmpty({ message: 'La cadena de conexión es requerida' })
  connectionString: string;

}
