import { HttpException } from '@nestjs/common';

/** Política de reintentos de reportes (issue #39). */
export interface RetryPolicy {
  /** Intentos totales, incluido el primero. */
  maxAttempts: number;
  /** Espera antes del primer reintento; se duplica en cada intento. */
  baseDelayMs: number;
  /** Tope de una espera individual. */
  maxDelayMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 5 * 60_000;

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function getReportRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: intFromEnv('REPORT_RETRY_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS, 1, 10),
    baseDelayMs: intFromEnv('REPORT_RETRY_BASE_DELAY_MS', DEFAULT_BASE_DELAY_MS, 100, 600_000),
    maxDelayMs: MAX_DELAY_MS,
  };
}

/** Espera antes del intento `attempt + 1`: base · 2^(attempt-1), con tope. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs);
}

/**
 * Solo se reintentan los fallos transitorios (red, fuentes caídas, timeouts, SMTP).
 * Los 4xx son errores de configuración o permisos: repetirlos daría el mismo resultado.
 */
export function isRetryableReportError(error: unknown): boolean {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status >= 500 || status === 408 || status === 429;
  }
  return true;
}

export class RetriesExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`Falló después de ${attempts} intento(s)`);
    this.name = 'RetriesExhaustedError';
  }
}

export interface RetryOptions {
  policy: RetryPolicy;
  isRetryable?: (error: unknown) => boolean;
  /** Se llama antes de esperar para el siguiente intento. */
  onRetry?: (nextAttempt: number, error: unknown, delayMs: number) => void | Promise<void>;
  /** Inyectable en tests para no esperar de verdad. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Ejecuta `operation` con reintentos y backoff exponencial.
 * Devuelve el resultado y los intentos usados; si se agotan, lanza RetriesExhaustedError.
 */
export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<{ value: T; attempts: number }> {
  const isRetryable = options.isRetryable ?? isRetryableReportError;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { value: await operation(attempt), attempts: attempt };
    } catch (error) {
      if (attempt >= options.policy.maxAttempts || !isRetryable(error)) {
        throw new RetriesExhaustedError(attempt, error);
      }
      const delayMs = backoffDelayMs(attempt, options.policy);
      await options.onRetry?.(attempt + 1, error, delayMs);
      await sleep(delayMs);
    }
  }
}
