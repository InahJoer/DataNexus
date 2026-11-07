import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from './interfaces/authenticated-user.interface.js';
import { AccountService } from './account.service.js';
import { ChangePasswordDto, RevokedSessionsDto, SessionResponseDto, UpdateProfileDto } from './dto/account.dto.js';
import { AuthUserResponseDto } from './dto/auth-response.dto.js';

const context = (request: AuthenticatedRequest) => ({ ipAddress: request.ip, userAgent: request.get('user-agent') ?? undefined });

/** Perfil, contraseña y sesiones del usuario autenticado (#64, pantalla "Perfil y seguridad" #72). */
@ApiTags('Auth')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT inválido o ausente.' })
@UseGuards(JwtAuthGuard)
@Controller('auth')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Patch('profile')
  @ApiOperation({ summary: 'Editar nombre y apellidos', description: 'El correo no se edita porque se usa para iniciar sesión.' })
  @ApiOkResponse({ type: AuthUserResponseDto })
  updateProfile(@Req() request: AuthenticatedRequest, @Body() dto: UpdateProfileDto) {
    return this.account.updateProfile(request.user, dto, context(request));
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @ApiOperation({
    summary: 'Cambiar la contraseña',
    description: 'Exige la contraseña actual, aplica la política de contraseñas y cierra las demás sesiones abiertas del usuario.',
  })
  @ApiBadRequestResponse({ description: 'La nueva contraseña no cumple la política o es igual a la actual.' })
  changePassword(@Req() request: AuthenticatedRequest, @Body() dto: ChangePasswordDto) {
    return this.account.changePassword(request.user, dto, context(request));
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Mis sesiones abiertas', description: 'Dispositivos con sesión activa; `actual` marca la de esta petición.' })
  @ApiOkResponse({ type: [SessionResponseDto] })
  listSessions(@Req() request: AuthenticatedRequest) {
    return this.account.listSessions(request.user);
  }

  @Delete('sessions/:id')
  @ApiOperation({ summary: 'Cerrar una de mis sesiones' })
  @ApiOkResponse({ type: RevokedSessionsDto })
  @ApiNotFoundResponse({ description: 'La sesión no existe, ya estaba cerrada o es de otro usuario.' })
  revokeSession(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.account.revokeSession(request.user, id, context(request));
  }
}
