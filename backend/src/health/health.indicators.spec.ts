import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { HealthIndicatorService, type PrismaHealthIndicator } from '@nestjs/terminus';
import type { MailService } from '../mailer/mail.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { HealthIndicators } from './health.indicators.js';

function indicators(options: { env?: Record<string, string>; smtpConfigured?: boolean; verify?: () => Promise<void> }) {
  const config = { get: (key: string) => options.env?.[key] } as unknown as ConfigService;
  const mail = {
    isConfigured: () => options.smtpConfigured ?? false,
    verify: options.verify ?? (() => Promise.resolve()),
  } as unknown as MailService;
  return new HealthIndicators(new HealthIndicatorService(), {} as PrismaHealthIndicator, {} as PrismaService, config, mail);
}

describe('HealthIndicators', () => {
  it('sin REDIS_URL la cola en memoria cuenta como disponible', async () => {
    expect(await indicators({}).redisQueue()).toEqual({
      redis: { status: 'up', mode: 'memory', message: 'Sin REDIS_URL: cola en memoria' },
    });
  });

  it('sin SMTP configurado informa del envío simulado sin abrir conexiones', async () => {
    const verify = vi.fn();
    expect((await indicators({ verify }).smtp()).smtp).toMatchObject({ status: 'up', mode: 'simulated' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('un SMTP que responde queda up', async () => {
    expect((await indicators({ smtpConfigured: true }).smtp()).smtp).toMatchObject({ status: 'up', mode: 'smtp' });
  });

  it('un SMTP caído degrada el servicio sin marcarlo como down (la API sigue sirviendo)', async () => {
    const result = await indicators({ smtpConfigured: true, verify: () => Promise.reject(new Error('EAUTH')) }).smtp();
    expect(result.smtp).toMatchObject({ status: 'degraded', mode: 'smtp' });
  });
});
