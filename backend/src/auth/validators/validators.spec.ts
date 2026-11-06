import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { getPasswordPolicyErrors } from './password-policy.js';
import { getBlockedEmailDomains, isCorporateEmail } from './corporate-email.js';
import { RegisterDto } from '../dto/register.dto.js';
import { ResetPasswordDto } from '../dto/password-reset.dto.js';
import { InviteUserDto } from '../../users/dto/invite-user.dto.js';

describe('Política de contraseñas', () => {
  it('acepta una contraseña que cumple todas las reglas', () => {
    expect(getPasswordPolicyErrors('Segura#2026dn')).toEqual([]);
    expect(getPasswordPolicyErrors('DataNexus2026!')).toEqual([]);
  });

  it.each([
    ['Corta#1a', 'al menos 10 caracteres'],
    ['sinmayuscula#2026', 'una letra mayúscula'],
    ['SINMINUSCULA#2026', 'una letra minúscula'],
    ['SinNumeros#Aqui', 'un número'],
    ['SinSimbolo2026Ab', 'un símbolo'],
    [' Espacio#2026Ab', 'sin espacios al inicio ni al final'],
    ['MiPassword#2026', 'contraseñas comunes'],
    ['Qwerty#2026Abc', 'contraseñas comunes'],
    [`${'Aa1#'.repeat(19)}`, 'como máximo 72 caracteres'],
  ])('rechaza "%s" por: %s', (password, regla) => {
    expect(getPasswordPolicyErrors(password).join(' | ')).toContain(regla);
  });

  it('rechaza contraseñas que contienen la parte local del correo', () => {
    expect(getPasswordPolicyErrors('Mlopez#2026x', 'mlopez@empresa.com')).toContain('no contener tu correo');
    expect(getPasswordPolicyErrors('Segura#2026dn', 'mlopez@empresa.com')).toEqual([]);
  });

  it('el mensaje del DTO lista en español todas las reglas incumplidas', () => {
    const dto = plainToInstance(ResetPasswordDto, { token: 'a'.repeat(43), newPassword: 'corta' });
    const message = Object.values(validateSync(dto)[0].constraints ?? {})[0];
    expect(message).toMatch(/^La contraseña no cumple la política de seguridad/);
    expect(message).toContain('al menos 10 caracteres');
    expect(message).toContain('una letra mayúscula');
    expect(message).toContain('un número');
  });
});

describe('Correo corporativo', () => {
  it.each(['ana@gmail.com', 'ANA@Hotmail.com', 'ana@outlook.es', 'ana@yahoo.com', 'ana@icloud.com'])(
    'rechaza el correo personal %s',
    (email) => expect(isCorporateEmail(email, {})).toBe(false),
  );

  it.each(['ana@empresa.com', 'ana@datanexus.demo', 'ana@uni.edu.ni'])('acepta %s', (email) => {
    expect(isCorporateEmail(email, {})).toBe(true);
  });

  it('BLOCKED_EMAIL_DOMAINS reemplaza la lista por defecto', () => {
    const env = { BLOCKED_EMAIL_DOMAINS: 'competencia.com, @otra.org' };
    expect(getBlockedEmailDomains(env)).toEqual(['competencia.com', 'otra.org']);
    expect(isCorporateEmail('x@competencia.com', env)).toBe(false);
    expect(isCorporateEmail('x@gmail.com', env)).toBe(true);
  });

  it('ALLOW_PERSONAL_EMAILS=true desactiva la regla', () => {
    expect(isCorporateEmail('ana@gmail.com', { ALLOW_PERSONAL_EMAILS: 'true' })).toBe(true);
  });

  it('bloquea también subdominios de un proveedor personal', () => {
    expect(isCorporateEmail('ana@mail.gmail.com', {})).toBe(false);
  });
});

describe('DTOs con la política aplicada', () => {
  const errorsOf = (dto: object) => validateSync(dto).map((error) => error.property);

  it('RegisterDto exige correo corporativo y contraseña segura', () => {
    const bad = plainToInstance(RegisterDto, {
      email: 'ana@gmail.com',
      name: 'Ana',
      password: 'Password123',
      workspaceId: 'ws',
    });
    expect(errorsOf(bad)).toEqual(expect.arrayContaining(['email', 'password']));

    const good = plainToInstance(RegisterDto, {
      email: 'ana@empresa.com',
      name: 'Ana',
      password: 'Segura#2026dn',
      workspaceId: 'ws',
    });
    expect(errorsOf(good)).toEqual([]);
  });

  it('InviteUserDto exige correo corporativo y ya no acepta contraseña temporal', () => {
    const base = { email: 'nuevo@empresa.com', name: 'Nuevo', role: 'LECTOR' };
    expect(errorsOf(plainToInstance(InviteUserDto, base))).toEqual([]);
    expect(errorsOf(plainToInstance(InviteUserDto, { ...base, name: '   ' }))).toContain('name');
    // La contraseña la define el invitado al aceptar (RF-06); el ValidationPipe global rechaza el campo extra.
    const withPassword = plainToInstance(InviteUserDto, { ...base, temporaryPassword: 'Temporal#2026dn' });
    expect(
      validateSync(withPassword, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property),
    ).toEqual(['temporaryPassword']);
    expect(errorsOf(plainToInstance(InviteUserDto, { ...base, email: 'nuevo@hotmail.com' }))).toContain('email');
  });
});
