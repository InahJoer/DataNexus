import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-user.interface.js';
import {
  CreatedPersonalAccessTokenDto,
  CreatePersonalAccessTokenDto,
  PatScopeDto,
  PersonalAccessTokenDto,
} from './dto/personal-access-token.dto.js';
import { PersonalAccessTokensService } from './personal-access-tokens.service.js';

const context = (request: AuthenticatedRequest) => ({ ipAddress: request.ip, userAgent: request.get('user-agent') ?? undefined });
const TOKEN_WRITE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * Tokens de acceso personal (issue #65, pantalla "Perfil y preferencias de seguridad").
 * Se gestionan solo con una sesión iniciada: un token no puede crear, rotar ni revocar tokens.
 */
@ApiTags('Auth')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Sesión inválida o ausente.' })
@ApiForbiddenResponse({ description: 'Los tokens de acceso personal no pueden gestionar tokens.' })
@UseGuards(JwtAuthGuard)
@Controller('auth/tokens')
export class PersonalAccessTokensController {
  constructor(private readonly tokens: PersonalAccessTokensService) {}

  @Get('scopes')
  @ApiOperation({ summary: 'Permisos que puede tener un token', description: '`disponible` indica si tu rol actual puede concederlo.' })
  @ApiOkResponse({ type: [PatScopeDto] })
  scopes(@Req() request: AuthenticatedRequest) {
    return this.tokens.scopes(request.user);
  }

  @Get()
  @ApiOperation({ summary: 'Mis tokens de acceso personal', description: 'Activos y caducados, con su vencimiento y último uso. Nunca devuelve el token.' })
  @ApiOkResponse({ type: [PersonalAccessTokenDto] })
  list(@Req() request: AuthenticatedRequest) {
    return this.tokens.list(request.user);
  }

  @Post()
  @Throttle(TOKEN_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Crear un token de acceso personal',
    description:
      'Devuelve el token completo **una sola vez**. Úsalo como `Authorization: Bearer pat_...`. ' +
      'Solo se pueden conceder permisos que tu rol tenga, y el token deja de servir para lo que tu rol pierda.',
  })
  @ApiCreatedResponse({ type: CreatedPersonalAccessTokenDto })
  create(@Req() request: AuthenticatedRequest, @Body() dto: CreatePersonalAccessTokenDto) {
    return this.tokens.create(request.user, dto, context(request));
  }

  @Post(':id/rotate')
  @Throttle(TOKEN_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Rotar un token',
    description: 'Revoca el token y emite otro con el mismo nombre, permisos y duración. El nuevo se muestra una sola vez.',
  })
  @ApiCreatedResponse({ type: CreatedPersonalAccessTokenDto })
  @ApiNotFoundResponse({ description: 'El token no existe, ya fue revocado o es de otro usuario.' })
  rotate(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.tokens.rotate(request.user, id, context(request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revocar un token', description: 'Deja de funcionar al instante.' })
  @ApiNoContentResponse({ description: 'Token revocado.' })
  @ApiNotFoundResponse({ description: 'El token no existe, ya fue revocado o es de otro usuario.' })
  async revoke(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.tokens.revoke(request.user, id, context(request));
  }
}
