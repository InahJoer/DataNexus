import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CatalogObjectResponseDto {
  @ApiProperty({ example: 'clientes' })
  name: string;

  @ApiProperty({ enum: ['TABLE', 'VIEW', 'COLLECTION'] })
  type: 'TABLE' | 'VIEW' | 'COLLECTION';

  @ApiPropertyOptional({ example: 'public' })
  schema?: string;
}

export class ConnectionSchemaResponseDto {
  @ApiProperty({ format: 'uuid' })
  connectionId: string;

  @ApiProperty({ example: 'POSTGRESQL' })
  tipoMotor: string;

  @ApiProperty({ type: [CatalogObjectResponseDto] })
  objects: CatalogObjectResponseDto[];
}

export class ConnectionFieldsResponseDto {
  @ApiProperty({ format: 'uuid' })
  connectionId: string;

  @ApiProperty({ example: 'clientes' })
  objectName: string;

  @ApiProperty({ type: [String], example: ['id', 'email', 'created_at'] })
  fields: string[];
}
