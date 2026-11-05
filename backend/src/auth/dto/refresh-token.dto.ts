import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token recibido en el login o en la última renovación' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{32,128}$/, { message: 'El refresh token tiene un formato inválido' })
  refresh_token: string;
}
