import { HttpException, HttpStatus } from '@nestjs/common';

export const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
export const DEFAULT_LOGIN_LOCK_MINUTES = 15;

export interface LockoutPolicy {
  maxAttempts: number;
  lockMs: number;
}

export function getLockoutPolicy(get: (key: string) => unknown): LockoutPolicy {
  const positive = (key: string, fallback: number) => {
    const value = Number(get(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    maxAttempts: positive('LOGIN_MAX_ATTEMPTS', DEFAULT_LOGIN_MAX_ATTEMPTS),
    lockMs: positive('LOGIN_LOCK_MINUTES', DEFAULT_LOGIN_LOCK_MINUTES) * 60_000,
  };
}

/** 423 Locked con los minutos restantes, para que el usuario sepa cuándo reintentar. */
export class AccountLockedException extends HttpException {
  constructor(lockedUntil: Date) {
    const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000));
    super(
      {
        statusCode: HttpStatus.LOCKED,
        error: 'Locked',
        message: `Tu cuenta está bloqueada temporalmente por varios intentos fallidos. Intenta de nuevo en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} o restablece tu contraseña.`,
        lockedUntil: lockedUntil.toISOString(),
      },
      HttpStatus.LOCKED,
    );
  }
}
