import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ExploreFieldsQueryDto {
  @ApiProperty({ maxLength: 150, example: 'clientes' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  objectName: string;

  @ApiPropertyOptional({ maxLength: 128, example: 'dbo' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  schema?: string;
}
