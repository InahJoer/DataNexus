import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'admin@datanexus.com', description: 'Correo electrónico del usuario' })
  @IsEmail({}, { message: 'El correo debe tener un formato válido' })
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Admin User', description: 'Nombre completo del usuario' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'SecurePassword123!', description: 'Contraseña en texto plano a hashear' })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ example: 'ADMIN', description: 'Rol del usuario', default: 'LECTOR', required: false })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiProperty({ example: 'UUID-DEL-WORKSPACE', description: 'ID del Workspace al que pertenece el usuario' })
  @IsString()
  @IsNotEmpty()
  workspaceId: string;
}
