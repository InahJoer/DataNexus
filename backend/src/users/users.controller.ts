import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { UpdateUserRoleDto } from './dto/update-user-role.dto.js';
import { InviteUserDto } from './dto/invite-user.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar miembros del workspace',
    description: 'Devuelve todos los usuarios que pertenecen al mismo Workspace del usuario autenticado.',
  })
  @ApiOkResponse({ description: 'Listado de usuarios del workspace.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  findAll(@Req() request: AuthenticatedRequest) {
    return this.usersService.findAll(request.user);
  }

  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invitar o dar de alta un nuevo miembro en el Workspace',
    description: 'Crea un nuevo usuario asignado directamente al workspace del administrador.',
  })
  @ApiResponse({ status: 201, description: 'Usuario creado exitosamente.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN para invitar miembros.' })
  @ApiConflictResponse({ description: 'El correo electrónico ya se encuentra registrado.' })
  invite(
    @Req() request: AuthenticatedRequest,
    @Body() dto: InviteUserDto,
  ) {
    return this.usersService.inviteMember(request.user, dto, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });
  }

  @Patch(':id/role')
  @ApiOperation({ summary: 'Cambiar el rol de un usuario del workspace' })
  @ApiResponse({ status: 200, description: 'Rol actualizado.' })
  @ApiForbiddenResponse({ description: 'Se requiere ADMIN del workspace.' })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado en el workspace.' })
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
