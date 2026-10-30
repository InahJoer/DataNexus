import { ApiProperty } from '@nestjs/swagger';

export class ConnectionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'POSTGRESQL' })
  tipoMotor: string;

  @ApiProperty({ example: 'db.internal' })
  host: string;

  @ApiProperty({ example: 'analytics' })
  dbName: string;

  @ApiProperty({ format: 'uuid' })
  workspaceId: string;
}
