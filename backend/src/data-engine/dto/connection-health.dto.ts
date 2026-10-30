import { ApiProperty } from '@nestjs/swagger';

export const CONNECTION_HEALTH_STATUSES = [
  'HEALTHY',
  'UNAVAILABLE',
  'UNSUPPORTED',
] as const;

export type ConnectionHealthStatus = (typeof CONNECTION_HEALTH_STATUSES)[number];

export class ConnectionHealthItemDto {
  @ApiProperty({ format: 'uuid' })
  connectionId: string;

  @ApiProperty({ example: 'PostgreSQL' })
  tipoMotor: string;

  @ApiProperty({ example: 'db.internal' })
  host: string;

  @ApiProperty({ example: 'analytics' })
  dbName: string;

  @ApiProperty({ enum: [...CONNECTION_HEALTH_STATUSES] })
  status: ConnectionHealthStatus;

  @ApiProperty({ type: Number, nullable: true, example: 42 })
  latencyMs: number | null;
}

export class ConnectionHealthResponseDto {
  @ApiProperty({ format: 'date-time' })
  checkedAt: string;

  @ApiProperty({ type: [ConnectionHealthItemDto] })
  connections: ConnectionHealthItemDto[];
}
