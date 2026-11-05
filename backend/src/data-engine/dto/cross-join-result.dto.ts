import { ApiProperty } from '@nestjs/swagger';

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
}
