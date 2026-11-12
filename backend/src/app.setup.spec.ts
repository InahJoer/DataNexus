import { describe, expect, it } from 'vitest';
import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { hasNamedThrottle } from './common/named-throttle.js';
import { trustProxySetting } from './app.setup.js';

describe('trustProxySetting', () => {
  it('convierte TRUST_PROXY al valor de Express', () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('1')).toBe(1);
  });
});

describe('hasNamedThrottle', () => {
  @Controller('demo')
  class DemoController {
    @Throttle({ export: { limit: 20, ttl: 60_000 } })
    @Get('export')
    exportData() {
      return 'ok';
    }

    @Get('list')
    list() {
      return 'ok';
    }
  }

  const contextFor = (method: 'exportData' | 'list') => {
    const handler = Object.getOwnPropertyDescriptor(DemoController.prototype, method)?.value as () => unknown;
    return { getHandler: () => handler, getClass: () => DemoController } as unknown as ExecutionContext;
  };

  it('el limitador de exportaciones solo cuenta en las rutas que lo declaran', () => {
    expect(hasNamedThrottle(contextFor('exportData'), 'export')).toBe(true);
    expect(hasNamedThrottle(contextFor('list'), 'export')).toBe(false);
  });
});
