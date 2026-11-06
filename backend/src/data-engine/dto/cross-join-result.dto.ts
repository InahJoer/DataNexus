import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PaginatedCrossJoinResultDto {
  @ApiProperty({ example: 128, minimum: 0 })
  total: number;

  @ApiProperty({ example: 50, minimum: 1, maximum: 1000 })
  limit: number;

  @ApiProperty({ example: 0, minimum: 0 })
  offset: number;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'Filas combinadas; los nombres de propiedad dependen de las fuentes.',
  })
  data: Record<string, unknown>[];

  @ApiPropertyOptional({ example: 100, enum: [50, 100, 500, 1000], description: 'Límite de filas pedido (RF-16)' })
  limiteFilas?: number;

  @ApiPropertyOptional({ example: true, description: 'true si el resultado tenía más filas que limiteFilas' })
  truncado?: boolean;
}
