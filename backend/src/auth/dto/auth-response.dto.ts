import { ApiProperty } from '@nestjs/swagger';
import { USER_ROLES, type UserRole } from '../interfaces/user-role.js';

export class AuthUserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'email' })
  email: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: [...USER_ROLES] })
  role: UserRole;

  @ApiProperty({ format: 'uuid' })
  workspaceId: string;
}

export class TokenPairResponseDto {
  @ApiProperty({ description: 'JWT de acceso para Authorization: Bearer (vence en expires_in segundos)' })
  access_token: string;

  @ApiProperty({
    description:
      'Refresh token rotativo para POST /auth/refresh. Es de un solo uso: cada renovación devuelve uno nuevo.',
  })
  refresh_token: string;

  @ApiProperty({ example: 900, description: 'Segundos de vida del access token' })
  expires_in: number;
}

export class AuthResponseDto extends TokenPairResponseDto {
  @ApiProperty({ type: AuthUserResponseDto })
  user: AuthUserResponseDto;
}
