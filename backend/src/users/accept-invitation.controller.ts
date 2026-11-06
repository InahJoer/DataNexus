import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MessageResponseDto } from '../auth/dto/password-reset.dto.js';
import { AcceptInvitationDto, InvitationPreviewDto, InvitationTokenDto } from './dto/invitation.dto.js';
import { InvitationsService } from './invitations.service.js';

/** 10 intentos cada 15 minutos por IP: frena la adivinación de tokens sin molestar al usuario real. */
const INVITATION_THROTTLE = { default: { limit: 10, ttl: 15 * 60_000 } };

/**
 * Endpoints públicos (sin JWT) para aceptar invitaciones. Viven bajo /auth junto al resto del
 * flujo de cuenta; el token va en el body para que no quede en logs de URL.
 */
@ApiTags('Auth')
@Throttle(INVITATION_THROTTLE)
@ApiResponse({ status: 429, description: 'Demasiadas solicitudes. Intenta más tarde.' })
@Controller('auth')
export class AcceptInvitationController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post('invitation-preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consultar una invitación antes de aceptarla',
    description: 'Devuelve correo, nombre, rol y workspace de una invitación pendiente y vigente.',
  })
  @ApiOkResponse({ type: InvitationPreviewDto })
  @ApiBadRequestResponse({ description: 'Invitación inválida, usada, revocada o expirada.' })
  preview(@Body() dto: InvitationTokenDto): Promise<InvitationPreviewDto> {
    return this.invitationsService.preview(dto.token);
  }

  @Post('accept-invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aceptar una invitación y definir la contraseña (RF-06)',
    description: 'Crea la cuenta con el rol de la invitación. El enlace es de un solo uso.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({ description: 'Invitación inválida, usada, revocada o expirada, o contraseña débil.' })
  @ApiConflictResponse({ description: 'Ya existe una cuenta con ese correo.' })
  accept(@Body() dto: AcceptInvitationDto, @Req() request: Request): Promise<MessageResponseDto> {
    return this.invitationsService.accept(dto, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });
  }
}
