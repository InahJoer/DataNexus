import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';

/** Política de contraseñas de DataNexus (RF-01). */
export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt ignora lo que pase de 72 bytes. */
export const PASSWORD_MAX_LENGTH = 72;

/** Contraseñas o fragmentos demasiado comunes (se comparan sin mayúsculas ni símbolos). */
const COMMON_PASSWORDS = [
  'password',
  'contrasena',
  'contraseña',
  'qwerty',
  '123456',
  'abc123',
  'admin123',
  'letmein',
  'welcome',
  'bienvenido',
];

export const PASSWORD_POLICY_DESCRIPTION =
  `Entre ${PASSWORD_MIN_LENGTH} y ${PASSWORD_MAX_LENGTH} caracteres, con al menos una mayúscula, ` +
  'una minúscula, un número y un símbolo. No puede contener tu correo ni contraseñas comunes.';

/**
 * Devuelve la lista de reglas que la contraseña incumple (vacía si es válida).
 * Si se pasa el correo, también impide usar su parte local (lo que va antes de @).
 */
export function getPasswordPolicyErrors(password: unknown, email?: unknown): string[] {
  if (typeof password !== 'string') return ['La contraseña debe ser un texto'];

  const errors: string[] = [];
  const length = Buffer.byteLength(password, 'utf8');

  if (password.length < PASSWORD_MIN_LENGTH) errors.push(`al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  if (length > PASSWORD_MAX_LENGTH) errors.push(`como máximo ${PASSWORD_MAX_LENGTH} caracteres`);
  if (!/[a-zñáéíóú]/.test(password)) errors.push('una letra minúscula');
  if (!/[A-ZÑÁÉÍÓÚ]/.test(password)) errors.push('una letra mayúscula');
  if (!/\d/.test(password)) errors.push('un número');
  if (!/[^A-Za-z0-9ñÑáéíóúÁÉÍÓÚ\s]/.test(password)) errors.push('un símbolo (por ejemplo ! @ # $ %)');
  if (/^\s|\s$/.test(password)) errors.push('sin espacios al inicio ni al final');

  const normalized = password.toLowerCase().replace(/[^a-z0-9ñáéíóú]/g, '');
  if (COMMON_PASSWORDS.some((common) => normalized.includes(common.replace(/[^a-z0-9ñáéíóú]/g, '')))) {
    errors.push('no usar contraseñas comunes como "password" o "123456"');
  }

  if (typeof email === 'string') {
    const localPart = email.split('@')[0]?.toLowerCase() ?? '';
    if (localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
      errors.push('no contener tu correo');
    }
  }

  return errors;
}

/**
 * Decorador de class-validator con la política de contraseñas.
 * Usa el campo `email` del mismo DTO, si existe, para impedir contraseñas que lo contengan.
 */
export function IsStrongPassword(options: ValidationOptions = {}) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isStrongPassword',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const email = (args.object as Record<string, unknown>).email;
          return getPasswordPolicyErrors(value, email).length === 0;
        },
        defaultMessage(args: ValidationArguments) {
          const email = (args.object as Record<string, unknown>).email;
          const errors = getPasswordPolicyErrors(args.value, email);
          return `La contraseña no cumple la política de seguridad. Debe tener: ${errors.join(', ')}.`;
        },
      },
    });
  };
}
