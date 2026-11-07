import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  PickType,
} from '@nestjs/swagger';
import { ResetPasswordDto } from '../auth/dto/password-reset.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RevokedSessionsDto } from '../auth/dto/account.dto.js';
import { MemberResponseDto } from './dto/member-response.dto.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { UpdateUserRoleDto } from './dto/update-user-role.dto.js';
import { InviteUserDto } from './dto/invite-user.dto.js';
import { UsersService } from './users.service.js';
import { InvitationsService } from './invitations.service.js';
import { InvitationResponseDto, ListInvitationsQueryDto } from './dto/invitation.dto.js';

const requestContext = (request: AuthenticatedRequest) => ({
  ipAddress: request.ip,
  userAgent: request.get('user-agent') ?? undefined,
});

const uuidPipe = new ParseUUIDPipe({ version: '4' });
class ResetMemberPasswordDto extends PickType(ResetPasswordDto, ['newPassword'] as const) {}

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly invitationsService: InvitationsService,
  ) {}

  @RequirePermission('MANAGE_MEMBERS')
  @Get()
  @ApiOperation({
    summary: 'Listar miembros del workspace (ADMIN)',
    description: 'Devuelve todos los usuarios que pertenecen al mismo Workspace del usuario autenticado.',
  })
  @ApiOkResponse({ description: 'Miembros con último acceso y sesiones abiertas.', type: [MemberResponseDto] })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN para listar miembros.' })
  @ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
  findAll(@Req() request: AuthenticatedRequest) {
    return this.usersService.findAll(request.user);
  }

  @RequirePermission('MANAGE_MEMBERS')
  @Post('sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cerrar todas las sesiones del workspace (ADMIN)', description: 'Excepto la sesión del propio administrador.' })
  @ApiOkResponse({ type: RevokedSessionsDto })
  revokeAllSessions(@Req() request: AuthenticatedRequest) {
    return this.usersService.revokeAllSessions(request.user, { ipAddress: request.ip, userAgent: request.get('user-agent') ?? undefined });
  }

  @RequirePermission('MANAGE_MEMBERS')
  @Post(':id/sessions/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cerrar las sesiones de un miembro (ADMIN)', description: 'Su siguiente petición recibe 401 y debe volver a iniciar sesión.' })
  @ApiOkResponse({ type: RevokedSessionsDto })
  revokeUserSessions(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.revokeUserSessions(request.user, id, { ipAddress: request.ip, userAgent: request.get('user-agent') ?? undefined });
  }

  @RequirePermission('MANAGE_MEMBERS')
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invitar a un nuevo miembro por enlace (RF-06)',
    description:
      'Crea una invitación con token de un solo uso y envía el enlace por correo. El usuario se crea al aceptarla con su propia contraseña. Respeta los dominios permitidos del workspace.',
  })
  @ApiCreatedResponse({ type: InvitationResponseDto })
  @ApiBadRequestResponse({ description: 'Correo fuera de los dominios permitidos o datos inválidos.' })
  @ApiForbiddenResponse({ description: 'Se requiere rol ADMIN para invitar miembros.' })
  @ApiConflictResponse({ description: 'El correo ya está registrado o ya tiene una invitación pendiente.' })
  invite(@Req() request: AuthenticatedRequest, @Body() dto: InviteUserDto) {
    return this.invitationsService.invite(request.user, dto, requestContext(request));
  }

  @RequirePermission('MANAGE_MEMBERS')
  @Get('invitations')
  @ApiOperation({ summary: 'Listar invitaciones del workspace (ADMIN)' })
  @ApiOkResponse({ type: [InvitationResponseDto] })
  listInvitations(@Req() request: AuthenticatedRequest, @Query() query: ListInvitationsQueryDto) {
    return this.invitationsService.list(request.user, query.estado);
  }

  @RequirePermission('MANAGE_MEMBERS')
  @Post('invitations/:id/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reenviar una invitación pendiente o expirada',
    description: 'Genera un enlace nuevo (el anterior deja de servir) y renueva el vencimiento.',
  })
  @ApiOkResponse({ type: InvitationResponseDto })
  @ApiNotFoundResponse({ description: 'Invitación no encontrada en el workspace.' })
  @ApiConflictResponse({ description: 'La invitación ya fue aceptada o revocada.' })
  resendInvitation(@Param('id', uuidPipe) id: string, @Req() request: AuthenticatedRequest) {
    return this.invitationsService.resend(request.user, id, requestContext(request));
  }

  @RequirePermission('MANAGE_MEMBERS')
  @Delete('invitations/:id')
  @ApiOperation({ summary: 'Revocar una invitación pendiente', description: 'Su enlace deja de servir de inmediato.' })
  @ApiOkResponse({ type: InvitationResponseDto })
  @ApiNotFoundResponse({ description: 'Invitación no encontrada en el workspace.' })
  @ApiConflictResponse({ description: 'La invitación ya fue aceptada o revocada.' })
  revokeInvitation(@Param('id', uuidPipe) id: string, @Req() request: AuthenticatedRequest) {
    return this.invitationsService.revoke(request.user, id, requestContext(request));
  }

  @RequirePermission('MANAGE_MEMBERS')
  @Patch(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cambiar la contraseña de otro miembro del workspace' })
  resetMemberPassword(
    @Param('id', uuidPipe) id: string,
    @Body() dto: ResetMemberPasswordDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.usersService.resetMemberPassword(request.user, id, dto.newPassword, requestContext(request));
  }

  @RequirePermission('MANAGE_MEMBERS')
  @Patch(':id/role')
  @ApiOperation({ summary: 'Cambiar el rol de un usuario del workspace' })
  @ApiResponse({ status: 200, description: 'Rol actualizado.' })
  @ApiForbiddenResponse({ description: 'Se requiere ADMIN del workspace.' })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado en el workspace.' })
  @ApiConflictResponse({ description: 'Es el último ADMINISTRADOR del workspace.' })
  updateRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() updateUserRoleDto: UpdateUserRoleDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.usersService.updateRole(request.user, id, updateUserRoleDto.role, requestContext(request));
  }

  @RequirePermission('MANAGE_MEMBERS')
  @Delete(':id')
  @ApiOperation({
    summary: 'Dar de baja a un miembro del workspace',
    description:
      'Elimina la cuenta y cierra sus sesiones. No se puede dar de baja uno mismo ni al último ADMINISTRADOR.',
  })
  @ApiOkResponse({ description: 'Miembro dado de baja (sin contraseña).' })
  @ApiForbiddenResponse({ description: 'Se requiere ADMIN o se intentó la baja propia.' })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado en el workspace.' })
  @ApiConflictResponse({ description: 'Es el último ADMINISTRADOR del workspace.' })
  remove(@Param('id', uuidPipe) id: string, @Req() request: AuthenticatedRequest) {
    return this.usersService.removeMember(request.user, id, requestContext(request));
  }
}
