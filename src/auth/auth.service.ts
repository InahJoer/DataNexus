import { Injectable, UnauthorizedException, ConflictException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import type { JwtPayload } from './interfaces/jwt-payload.interface.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Valida las credenciales de un usuario y genera un token JWT.
   * @param loginDto Datos de autenticación (email y contraseña)
   * @returns Token JWT de acceso y datos públicos del usuario
   */
  async login(loginDto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email.toLowerCase() },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      workspaceId: user.workspaceId,
    };

    const token = this.jwtService.sign(payload);

    return {
      access_token: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        workspaceId: user.workspaceId,
      },
    };
  }

  /**
   * Registra un nuevo usuario con la contraseña encriptada mediante bcrypt.
   * Método de utilidad para crear usuarios válidos y poblar el sistema.
   * @param registerDto Datos para el registro del usuario
   */
  async register(registerDto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: registerDto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException('Ya existe un usuario con este correo electrónico');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: registerDto.workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException(`El workspace con ID ${registerDto.workspaceId} no existe`);
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(registerDto.password, saltRounds);

    const newUser = await this.prisma.user.create({
      data: {
        email: registerDto.email.toLowerCase(),
        name: registerDto.name,
        password: hashedPassword,
        role: registerDto.role ?? 'LECTOR',
        workspaceId: registerDto.workspaceId,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        workspaceId: true,
      },
    });

    return newUser;
  }
}
