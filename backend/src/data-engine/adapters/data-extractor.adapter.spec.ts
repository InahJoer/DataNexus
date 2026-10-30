import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DataExtractorService } from './data-extractor.adapter.js';

const connection = {
  id: 'connection-1',
  tipoMotor: 'SQLServer',
  dbName: 'analytics',
  encryptedConnectionString: 'encrypted-connection-string',
};

describe('DataExtractorService', () => {
  it('delegates extraction to the adapter selected for the connection motor', async () => {
    const adapter = {
      extract: vi.fn().mockResolvedValue([{ id: 'row-from-provider' }]),
    };
    const createAdapter = vi.fn().mockReturnValue(adapter);
    const service = new DataExtractorService(createAdapter as never);

    await expect(service.extract(connection, 'customers')).resolves.toEqual([
      { id: 'row-from-provider' },
    ]);
    expect(createAdapter).toHaveBeenCalledWith('SQLServer');
    expect(adapter.extract).toHaveBeenCalledWith(
      connection,
      'customers',
      undefined,
    );
  });

  it('rejects a motor without a registered real extractor instead of returning sample rows', async () => {
    const createAdapter = vi.fn().mockReturnValue(undefined);
    const service = new DataExtractorService(createAdapter as never);

    await expect(
      service.extract({ ...connection, tipoMotor: 'Oracle' }, 'customers'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps provider failures to safe HTTP errors without exposing credentials', async () => {
    const service = new DataExtractorService((() => ({
      extract: vi
        .fn()
        .mockRejectedValue(new Error('login failed for password=secret-value')),
    })) as never);

    const error = await service
      .extract(connection, 'customers')
      .catch((reason) => reason);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error.message).not.toContain('secret-value');
  });

  it('maps provider timeouts to HTTP 504', async () => {
    const timeout = Object.assign(new Error('request deadline exceeded'), {
      code: 'ETIMEOUT',
    });
    const service = new DataExtractorService((() => ({
      extract: vi.fn().mockRejectedValue(timeout),
    })) as never);

    const error = await service
      .extract(connection, 'customers')
      .catch((reason) => reason);

    expect(error).toBeInstanceOf(GatewayTimeoutException);
  });
});
