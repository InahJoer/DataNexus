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

export class AuthResponseDto {
  @ApiProperty({ description: 'JWT de acceso para Authorization: Bearer' })
  access_token: string;

  @ApiProperty({ type: AuthUserResponseDto })
  user: AuthUserResponseDto;
}
