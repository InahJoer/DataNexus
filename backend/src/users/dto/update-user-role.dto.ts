import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateUserRoleDto {
  @ApiProperty({ enum: ['ADMIN', 'LECTOR'], example: 'LECTOR' })
  @IsIn(['ADMIN', 'LECTOR'], { message: 'El rol debe ser ADMIN o LECTOR' })
  role: 'ADMIN' | 'LECTOR';
}
