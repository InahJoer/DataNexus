import { describe, expect, it, vi } from 'vitest';
import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { DataEngineService } from './data-engine.service.js';
import { UnsupportedOperationError, type IDataSourceAdapter } from './adapters/data-source-adapter.interface.js';
import type { AdapterRegistry } from './adapters/adapter-registry.js';
import type { DataSourceClientPool } from './pool/data-source-client-pool.js';
import type { ConnectionsService } from '../connections/connections.service.js';

const actor = { id: 'u', email: 'u@x.com', name: 'U', role: 'ADMIN', workspaceId: 'ws-1' } as never;
const payload = {
  conexionSqlId: 'sql',
  conexionNoSqlId: 'nosql',
  tablaSql: 'clientes',
  coleccionNoSql: 'pedidos',
  llaveSql: 'id',
  llaveNoSql: 'cliente_id',
};

/** Motor de datos con un adaptador para "sql" cuyo extract se controla en cada test; "nosql" devuelve []. */
function engineWith(sqlAdapter: Partial<IDataSourceAdapter> | undefined) {
  const pool = { invalidate: vi.fn().mockResolvedValue(undefined) };
  const connections = {
    getConnectionForExploration: vi.fn((id: string) =>
      Promise.resolve({ id, tipoMotor: id === 'sql' ? 'MYSQL' : 'FIRESTORE', dbName: 'db', connectionString: 'secret-dsn' }),
    ),
  } as unknown as ConnectionsService;
  const registry = {
    get: vi.fn((tipoMotor: string) => {
      const capabilities = { explore: true, fields: true, extract: true };
      if (tipoMotor === 'FIRESTORE') return { tipoMotor, capabilities, extract: vi.fn().mockResolvedValue([]) };
      return sqlAdapter ? { tipoMotor, capabilities, ...sqlAdapter } : undefined;
    }),
  } as unknown as AdapterRegistry;
  return { service: new DataEngineService(connections, registry, pool as unknown as DataSourceClientPool), pool };
}

describe('DataEngineService: errores de extracción', () => {
  it('rechaza con 400 un motor sin adaptador', async () => {
    const { service } = engineWith(undefined);
    await expect(service.executeCrossJoin(payload, actor)).rejects.toThrow(BadRequestException);
  });

  it('rechaza con 400 un adaptador sin extracción (por capacidad o por UnsupportedOperationError)', async () => {
    const byCapability = engineWith({ capabilities: { explore: true, fields: true, extract: false } });
    await expect(byCapability.service.executeCrossJoin(payload, actor)).rejects.toThrow(
      'El motor de la conexión no tiene un extractor real disponible',
    );
    const byError = engineWith({ extract: vi.fn().mockRejectedValue(new UnsupportedOperationError('x')) });
    await expect(byError.service.executeCrossJoin(payload, actor)).rejects.toThrow(BadRequestException);
  });

  it('propaga los errores HTTP del adaptador (p. ej. 413 por límite de filas)', async () => {
    const { service } = engineWith({ extract: vi.fn().mockRejectedValue(new PayloadTooLargeException('máximo')) });
    await expect(service.executeCrossJoin(payload, actor)).rejects.toThrow(PayloadTooLargeException);
  });

  it('convierte errores del proveedor en 502 sin filtrar detalles de conexión', async () => {
    const { service } = engineWith({
      extract: vi.fn().mockRejectedValue(new Error('Access denied for user root@secret-dsn')),
    });
    const error = await service.executeCrossJoin(payload, actor).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as Error).message).not.toContain('secret-dsn');
  });

  it('convierte un timeout en 504 y descarta los clientes de esa conexión', async () => {
    const { service, pool } = engineWith({
      extract: vi.fn().mockRejectedValue(Object.assign(new Error('MySQL query timeout'), { code: 'ETIMEDOUT' })),
    });
    await expect(service.executeCrossJoin(payload, actor)).rejects.toThrow(GatewayTimeoutException);
    expect(pool.invalidate).toHaveBeenCalledWith('sql');
  });
});
