import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsCorporateEmail } from '../../auth/validators/corporate-email.js';
import { USER_ROLES, type UserRole } from '../../auth/interfaces/user-role.js';

export class InviteUserDto {
  @ApiProperty({ description: 'Correo electrónico del nuevo miembro', example: 'nuevo.miembro@empresa.com' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'El correo debe ser una dirección de email válida' })
  @IsCorporateEmail()
  @MaxLength(254)
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Nombre completo del miembro', example: 'María López' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @MaxLength(120)
  name: string;

  @ApiProperty({
    description: 'Rol que tendrá el usuario al aceptar la invitación',
    enum: [...USER_ROLES],
    example: 'LECTOR',
  })
  @IsIn([...USER_ROLES], { message: 'El rol debe ser ADMIN, OPERADOR, LECTOR o AUDITOR' })
  role: UserRole;
}
