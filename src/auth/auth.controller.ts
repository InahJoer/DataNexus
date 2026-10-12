import { Controller, Post, Body, HttpCode, HttpStatus, Get, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Iniciar sesión en DataNexus',
    description: 'Valida las credenciales del usuario con bcrypt y devuelve un JWT firmado',
  })
  @ApiResponse({
    status: 200,
    description: 'Autenticación exitosa. Retorna el token JWT y los datos del usuario.',
  })
  @ApiResponse({
    status: 401,
    description: 'Credenciales inválidas (email o contraseña incorrectos).',
  })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
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
  @ApiResponse({
    status: 200,
    description: 'Datos del usuario autenticado obtenidos desde el token',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado / Token ausente o inválido',
  })
  getProfile(@Request() req: any) {
    return req.user;
  }
}
