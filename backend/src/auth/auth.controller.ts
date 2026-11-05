import { Controller, Post, Body, HttpCode, HttpStatus, Get, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { AuthResponseDto, AuthUserResponseDto } from './dto/auth-response.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from './interfaces/authenticated-user.interface.js';
import { Throttle } from '@nestjs/throttler';
import { PasswordResetService } from './password-reset.service.js';
import { ForgotPasswordDto, MessageResponseDto, ResetPasswordDto } from './dto/password-reset.dto.js';

/** 5 solicitudes cada 15 minutos por IP en los endpoints de recuperación. */
const PASSWORD_RESET_THROTTLE = { default: { limit: 5, ttl: 15 * 60_000 } };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordResetService: PasswordResetService,
  ) {}

  @Throttle(PASSWORD_RESET_THROTTLE)
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Solicitar enlace de recuperación de contraseña (RF-03)',
    description:
      'Envía un enlace de un solo uso que vence en 30 minutos. La respuesta es la misma exista o no el correo.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiResponse({ status: 429, description: 'Demasiadas solicitudes. Intenta más tarde.' })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() request: Request): Promise<MessageResponseDto> {
    return this.passwordResetService.requestReset(dto.email, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });
  }

  @Throttle(PASSWORD_RESET_THROTTLE)
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restablecer la contraseña con el token del correo',
    description: 'Consume el token (un solo uso) y guarda la nueva contraseña con bcrypt.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Token inválido, usado o expirado, o contraseña inválida.' })
  @ApiResponse({ status: 429, description: 'Demasiadas solicitudes. Intenta más tarde.' })
  resetPassword(@Body() dto: ResetPasswordDto, @Req() request: Request): Promise<MessageResponseDto> {
    return this.passwordResetService.resetPassword(dto.token, dto.newPassword, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Iniciar sesión en DataNexus',
    description: 'Valida las credenciales del usuario con bcrypt y devuelve un JWT firmado',
  })
  @ApiOkResponse({
    description: 'Autenticación exitosa. Retorna el token JWT y los datos del usuario.',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Credenciales inválidas (email o contraseña incorrectos).',
  })
  async login(
    @Body() loginDto: LoginDto,
    @Req() request: Request,
  ): Promise<AuthResponseDto> {
    return this.authService.login(loginDto, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Registrar un nuevo usuario',
    description: 'Crea un nuevo usuario en la base de datos con contraseña hasheada mediante bcrypt',
  })
  @ApiResponse({
    status: 201,
    description: 'Usuario registrado exitosamente.',
  })
  @ApiResponse({
    status: 409,
    description: 'El correo electrónico ya se encuentra registrado.',
  })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Consultar perfil del usuario autenticado',
    description: 'Ruta protegida que valida el token JWT emitido',
  })
  @ApiOkResponse({
    description: 'Datos del usuario autenticado obtenidos desde el token',
    type: AuthUserResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado / Token ausente o inválido',
  })
  getProfile(@Req() req: AuthenticatedRequest): AuthUserResponseDto {
    return req.user;
  }
}
