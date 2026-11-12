import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Campos de texto que acompañan al archivo en la subida (multipart/form-data). */
export class UploadExcelFieldsDto {
  @ApiPropertyOptional({ description: 'Nombre visible; por defecto, el nombre del archivo sin extensión.', example: 'Metas de ventas 2026', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  nombre?: string;
}

export class RenameExcelDto {
  @ApiProperty({ example: 'Metas de ventas 2026', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'El nombre no puede estar vacío' })
  @MaxLength(120)
  nombre!: string;
}

export class ExcelSheetResponseDto {
  @ApiProperty({ example: 'Clientes' })
  nombre!: string;

  @ApiProperty({ type: [String], example: ['codigo', 'nombre', 'meta'] })
  columnas!: string[];

  @ApiProperty({ description: 'Primera columna de la hoja: identificador de cada registro.', example: 'codigo' })
  columnaId!: string;

  @ApiProperty({ example: 120 })
  totalFilas!: number;

  @ApiProperty({ type: [String], description: "Tipo de cada columna en el orden de columnas: texto, numero o booleano.", example: ["texto", "texto", "numero"] })
  tipos!: string[];
}

export class ExcelUsageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  nombre!: string;
}

export class ExcelFileResponseDto {
  @ApiProperty({ description: 'Se usa como conexionId en el explorador, el editor de consultas y las exportaciones.' })
  id!: string;

  @ApiProperty({ example: 'Metas de ventas 2026' })
  nombre!: string;

  @ApiProperty({ example: 'metas_2026.xlsx' })
  nombreArchivo!: string;

  @ApiProperty({ example: 48213 })
  tamanoBytes!: number;

  @ApiProperty({ example: 'analista@empresa.com' })
  creadoPor!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ type: [ExcelSheetResponseDto] })
  hojas!: ExcelSheetResponseDto[];

  @ApiProperty({ enum: ['PROCESANDO', 'LISTO', 'ERROR'], description: 'La carga corre en segundo plano: consulta el archivo hasta que esté LISTO.' })
  estado!: 'PROCESANDO' | 'LISTO' | 'ERROR';

  @ApiProperty({ description: 'Avance de la carga, de 0 a 100.', example: 100 })
  progreso!: number;

  @ApiProperty({ description: 'Registros guardados (durante la carga, los leídos hasta ahora).', example: 1250000 })
  filasProcesadas!: number;

  @ApiPropertyOptional({ type: String, description: 'Motivo de la última carga fallida. Si falla un reemplazo, los datos anteriores siguen disponibles.', nullable: true })
  error?: string | null;

  @ApiProperty({ type: [String], description: 'Observaciones de la última carga (encabezados ajustados, identificadores vacíos o repetidos).' })
  avisos!: string[];

  @ApiPropertyOptional({ type: [ExcelUsageDto], description: 'Reportes guardados que usan el archivo (solo en el detalle).' })
  usadoEn?: ExcelUsageDto[];
}

export interface UploadedExcelFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  path?: string;
}
