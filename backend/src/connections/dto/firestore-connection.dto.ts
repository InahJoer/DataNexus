import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Límite del archivo de Service Account; uno real ocupa ~2,4 KB. */
export const SERVICE_ACCOUNT_MAX_BYTES = 64 * 1024;

/** Campos de texto del formulario multipart de Firestore; el JSON llega como archivo `serviceAccount`. */
export class FirestoreUploadFieldsDto {
  @ApiPropertyOptional({ example: 'Firebase app móvil' })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'El nombre debe ser un texto' })
  @MaxLength(120, { message: 'El nombre no puede superar 120 caracteres' })
  nombre?: string;

  @ApiPropertyOptional({ default: '(default)', example: '(default)' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^(\(default\)|[a-z][a-z0-9-]{2,62})$/, {
    message: 'databaseId debe ser "(default)" o un identificador de Firestore válido',
  })
  databaseId?: string;
}

/** Descripción Swagger del formulario multipart. */
export const FIRESTORE_UPLOAD_SCHEMA = {
  type: 'object',
  required: ['serviceAccount'],
  properties: {
    serviceAccount: {
      type: 'string',
      format: 'binary',
      description: 'Archivo JSON de Service Account (máx. 64 KB). Se procesa en memoria y nunca se escribe en disco.',
    },
    nombre: { type: 'string', maxLength: 120 },
    databaseId: { type: 'string', default: '(default)' },
  },
};

/** Archivo recibido por multer con almacenamiento en memoria (sin ruta en disco). */
export interface UploadedServiceAccountFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  path?: string;
}
