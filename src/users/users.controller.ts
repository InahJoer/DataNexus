import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { UpdateUserRoleDto } from './dto/update-user-role.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch(':id/role')
  @ApiOperation({ summary: 'Cambiar el rol de un usuario del workspace' })
  @ApiResponse({ status: 200, description: 'Rol actualizado.' })
  @ApiResponse({ status: 403, description: 'Se requiere ADMIN del workspace.' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado en el workspace.' })
  updateRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() updateUserRoleDto: UpdateUserRoleDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.usersService.updateRole(request.user, id, updateUserRoleDto.role, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });
  }
}
