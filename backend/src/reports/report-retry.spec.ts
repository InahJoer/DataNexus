import { BadGatewayException, BadRequestException, NotFoundException, RequestTimeoutException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RetriesExhaustedError,
  backoffDelayMs,
  getReportRetryPolicy,
  isRetryableReportError,
  retryWithBackoff,
} from './report-retry.js';

const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 5_000 };

describe('Reintentos de reportes con backoff (issue #39)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('duplica la espera en cada intento y respeta el tope', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, policy))).toEqual([
      1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });

  it('reintenta fallos transitorios y devuelve los intentos usados', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new BadGatewayException('fuente caída'))
      .mockResolvedValue('ok');

    const result = await retryWithBackoff(operation, { policy, sleep, onRetry });

    expect(result).toEqual({ value: 'ok', attempts: 3 });
    expect(operation.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
    expect(onRetry.mock.calls.map(([next, , delay]) => [next, delay])).toEqual([
      [2, 1_000],
      [3, 2_000],
    ]);
  });

  it('no reintenta errores 4xx de configuración o permisos', async () => {
    const sleep = vi.fn();
    const operation = vi.fn().mockRejectedValue(new BadRequestException('AUDITOR no puede recibir'));

    const error = await retryWithBackoff(operation, { policy, sleep }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetriesExhaustedError);
    expect((error as RetriesExhaustedError).attempts).toBe(1);
    expect((error as RetriesExhaustedError).lastError).toBeInstanceOf(BadRequestException);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('se rinde tras el máximo de intentos con el último error', async () => {
    const last = new Error('SMTP caído');
    const operation = vi.fn().mockRejectedValueOnce(new Error('primero')).mockRejectedValue(last);

    const error = (await retryWithBackoff(operation, { policy, sleep: async () => undefined }).catch(
      (caught: unknown) => caught,
    )) as RetriesExhaustedError;

    expect(error.attempts).toBe(3);
    expect(error.lastError).toBe(last);
  });

  it.each([
    [new BadGatewayException(), true],
    [new RequestTimeoutException(), true],
    [new Error('ETIMEDOUT'), true],
    [new BadRequestException(), false],
    [new NotFoundException(), false],
  ])('clasifica %s como reintentable = %s', (error, expected) => {
    expect(isRetryableReportError(error)).toBe(expected);
  });

  it('lee la política del entorno con valores acotados', () => {
    expect(getReportRetryPolicy()).toMatchObject({ maxAttempts: 3, baseDelayMs: 30_000 });
    vi.stubEnv('REPORT_RETRY_MAX_ATTEMPTS', '5');
    vi.stubEnv('REPORT_RETRY_BASE_DELAY_MS', '2000');
    expect(getReportRetryPolicy()).toMatchObject({ maxAttempts: 5, baseDelayMs: 2_000 });
    vi.stubEnv('REPORT_RETRY_MAX_ATTEMPTS', '99');
    expect(getReportRetryPolicy().maxAttempts).toBe(10);
  });
});
