import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CrossJoinDto, REPORT_FORMATS, type ReportFormat } from '../../data-engine/dto/cross-join.dto.js';

export class TriggerReportDto {
  @ApiProperty({
    description: 'Nombre descriptivo del reporte para el asunto del correo',
    example: 'Reporte Diario de Ventas y Envíos',
  })
  @IsString()
  @IsNotEmpty()
  reportTitle: string;

  @ApiProperty({
    description: 'Lista de correos de analistas o interesados destinatarios',
    example: ['analista@empresa.com', 'gerencia@empresa.com'],
  })
  @IsArray()
  @IsEmail({}, { each: true, message: 'Cada elemento debe ser un correo válido' })
  recipients: string[];

  @ApiProperty({
    description: 'Formato del archivo del reporte (excel, pdf o word)',
    enum: REPORT_FORMATS,
    example: 'excel',
  })
  @IsIn(REPORT_FORMATS, { message: 'El formato debe ser excel, pdf o word' })
  format: ReportFormat;

  @ApiProperty({
    description: 'Parámetros del Cross-Join para extraer y combinar los datos',
  })
  @ValidateNested()
  @Type(() => CrossJoinDto)
  crossJoinParams: CrossJoinDto;

  @ApiPropertyOptional({
    description: 'Mensaje personalizado en el cuerpo del correo',
    example: 'Estimados, adjunto el consolidado generado por DataNexus.',
  })
  @IsOptional()
  @IsString()
  customMessage?: string;
}
