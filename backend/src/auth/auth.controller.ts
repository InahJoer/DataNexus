import { Controller, Post, Body, HttpCode, HttpStatus, Get, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { SignupDto } from './dto/signup.dto.js';
import { AuthResponseDto, AuthUserResponseDto } from './dto/auth-response.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from './interfaces/authenticated-user.interface.js';
import { Throttle } from '@nestjs/throttler';
import { PasswordResetService } from './password-reset.service.js';
import { ForgotPasswordDto, MessageResponseDto, ResetPasswordDto } from './dto/password-reset.dto.js';
import { SessionsService } from './sessions.service.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';

/** 5 solicitudes cada 15 minutos por IP en los endpoints de recuperación. */
const PASSWORD_RESET_THROTTLE = { default: { limit: 5, ttl: 15 * 60_000 } };
/** Alta de cuentas: 5 por IP cada hora, para frenar registros automatizados. */
const SIGNUP_THROTTLE = { default: { limit: 5, ttl: 60 * 60_000 } };

const requestContext = (request: Request) => ({
  ipAddress: request.ip,
  userAgent: request.get('user-agent') ?? undefined,
});

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordResetService: PasswordResetService,
    private readonly sessionsService: SessionsService,
  ) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Renovar el access token con el refresh token (rotación)',
    description:
      'Devuelve un access token nuevo y un refresh token nuevo; el anterior deja de servir. Si la sesión lleva más de 30 minutos sin actividad, venció o el refresh token ya se había usado, responde 401 y la sesión queda cerrada.',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Sesión expirada, cerrada o refresh token inválido.' })
  refresh(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<AuthResponseDto> {
    return this.sessionsService.refresh(dto.refresh_token, requestContext(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cerrar sesión',
    description:
      'Revoca la sesión del refresh token: tanto el refresh token como los access tokens emitidos dejan de funcionar de inmediato. Es idempotente.',
  })
  @ApiResponse({ status: 204, description: 'Sesión cerrada (o ya estaba cerrada).' })
  async logout(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<void> {
    await this.sessionsService.logout(dto.refresh_token, requestContext(request));
  }

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

  @Throttle(SIGNUP_THROTTLE)
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Crear una cuenta personal u organización',
    description:
      'Crea el usuario (ADMIN) y su workspace e inicia sesión. PERSONAL admite cualquier correo y no tiene miembros; ' +
      'ORGANIZACION exige correo corporativo y deja su dominio como dominio permitido para invitar al equipo.',
  })
  @ApiResponse({ status: 201, description: 'Cuenta creada; devuelve los tokens como el login.', type: AuthResponseDto })
  @ApiResponse({ status: 409, description: 'Ya existe una cuenta con ese correo.' })
  signup(@Body() dto: SignupDto, @Req() request: Request) {
    return this.authService.signup(dto, { ipAddress: request.ip, userAgent: request.get('user-agent') ?? undefined });
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
