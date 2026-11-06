import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConnectionTestService, getDefaultConnectionTestTimeoutMs } from './connection-test.service.js';
import type { ConnectionsService } from './connections.service.js';
import type { ConnectionTester } from './testing/connection-tester.interface.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';

const actor = {
  id: 'user-1',
  email: 'operador@example.com',
  name: 'Operador',
  role: 'OPERADOR',
  workspaceId: 'workspace-1',
} as unknown as AuthenticatedUser;

const SECRET = 'postgres://admin:SuperSecret@db.internal:5432/analytics';
const CONNECTION_ID = '6f1c2b7e-1d1a-4c5e-9f3a-2b1c0d9e8f7a';

function makeTester(ping: ConnectionTester['ping']): ConnectionTester {
  return { ping: vi.fn(ping), close: vi.fn().mockResolvedValue(undefined) };
}

function makeService(tester: ConnectionTester | undefined, connectionsService: Partial<ConnectionsService> = {}) {
  const factory = vi.fn().mockReturnValue(tester);
  return {
    factory,
    service: new ConnectionTestService(connectionsService as ConnectionsService, factory),
  };
}

describe('ConnectionTestService (RF-10)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('devuelve { ok, latencyMs, serverVersion, error } y cierra la conexión', async () => {
    const tester = makeTester(async () => ({ serverVersion: 'PostgreSQL 16.2' }));
    const { service, factory } = makeService(tester);

    const result = await service.testCredentials({
      tipoMotor: 'POSTGRESQL',
      dbName: 'analytics',
      connectionString: SECRET,
    });

    expect(Object.keys(result).sort()).toEqual(['error', 'latencyMs', 'ok', 'serverVersion']);
    expect(result).toMatchObject({ ok: true, serverVersion: 'PostgreSQL 16.2', error: null });
    expect(result.latencyMs).toEqual(expect.any(Number));
    expect(factory).toHaveBeenCalledWith('POSTGRESQL');
    expect(tester.ping).toHaveBeenCalledWith(SECRET, 'analytics', 10_000);
    expect(tester.close).toHaveBeenCalledOnce();
  });

  it('no persiste nada al probar credenciales nuevas', async () => {
    const tester = makeTester(async () => ({ serverVersion: 'MySQL 8.0.36' }));
    const connectionsService = {
      create: vi.fn(),
      update: vi.fn(),
      getConnectionForExploration: vi.fn(),
    };
    const { service } = makeService(tester, connectionsService as unknown as ConnectionsService);

    await service.testCredentials({ tipoMotor: 'MYSQL', dbName: 'shop', connectionString: 'mysql://u:p@h/shop' });

    expect(connectionsService.create).not.toHaveBeenCalled();
    expect(connectionsService.update).not.toHaveBeenCalled();
    expect(connectionsService.getConnectionForExploration).not.toHaveBeenCalled();
  });

  it('prueba una conexión guardada con las credenciales descifradas del workspace', async () => {
    const tester = makeTester(async () => ({ serverVersion: 'SQL Server 16.0 (Developer Edition)' }));
    const getConnectionForExploration = vi.fn().mockResolvedValue({
      id: CONNECTION_ID,
      tipoMotor: 'SQLSERVER',
      dbName: 'erp',
      connectionString: 'Server=sql;User Id=sa;Password=SuperSecret',
    });
    const { service } = makeService(tester, { getConnectionForExploration } as Partial<ConnectionsService>);

    const result = await service.testSaved(actor, CONNECTION_ID, { timeoutMs: 3000 });

    expect(getConnectionForExploration).toHaveBeenCalledWith(CONNECTION_ID, 'workspace-1');
    expect(tester.ping).toHaveBeenCalledWith('Server=sql;User Id=sa;Password=SuperSecret', 'erp', 3000);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SuperSecret');
  });

  it('propaga 404 si la conexión no pertenece al workspace', async () => {
    const tester = makeTester(async () => ({ serverVersion: null }));
    const { service } = makeService(tester, {
      getConnectionForExploration: vi.fn().mockRejectedValue(new NotFoundException()),
    } as Partial<ConnectionsService>);

    await expect(service.testSaved(actor, CONNECTION_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(tester.ping).not.toHaveBeenCalled();
  });

  it('normaliza errores de credenciales sin filtrar el mensaje del driver', async () => {
    const tester = makeTester(async () => {
      throw Object.assign(new Error(`password authentication failed for ${SECRET}`), { code: '28P01' });
    });
    const { service } = makeService(tester);

    const result = await service.testCredentials({ tipoMotor: 'POSTGRESQL', dbName: 'a', connectionString: SECRET });

    expect(result).toEqual({
      ok: false,
      latencyMs: null,
      serverVersion: null,
      error: { code: 'AUTH_FAILED', message: 'Usuario o contraseña incorrectos.' },
    });
    expect(tester.close).toHaveBeenCalledOnce();
  });

  it('respeta el timeout pedido y cierra el driver colgado', async () => {
    vi.useFakeTimers();
    const tester = makeTester(() => new Promise(() => undefined));
    const { service } = makeService(tester);

    const pending = service.testCredentials({
      tipoMotor: 'MYSQL',
      dbName: 'shop',
      connectionString: 'mysql://u:p@h/shop',
      timeoutMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(2001);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      code: 'TIMEOUT',
      message: 'MySQL no respondió en 2 segundos. Revise el host, el puerto y el firewall.',
    });
    expect(tester.close).toHaveBeenCalledOnce();
  });

  it('toma el timeout por defecto de CONNECTION_TEST_TIMEOUT_MS, acotado a 1–30 s', () => {
    expect(getDefaultConnectionTestTimeoutMs()).toBe(10_000);
    vi.stubEnv('CONNECTION_TEST_TIMEOUT_MS', '4000');
    expect(getDefaultConnectionTestTimeoutMs()).toBe(4000);
    vi.stubEnv('CONNECTION_TEST_TIMEOUT_MS', '999999');
    expect(getDefaultConnectionTestTimeoutMs()).toBe(30_000);
    vi.stubEnv('CONNECTION_TEST_TIMEOUT_MS', 'abc');
    expect(getDefaultConnectionTestTimeoutMs()).toBe(10_000);
  });

  it('responde UNSUPPORTED_ENGINE para motores sin probador', async () => {
    const { service } = makeService(undefined);

    const result = await service.testCredentials({ tipoMotor: 'MONGODB', dbName: 'x', connectionString: 'mongodb://x' });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNSUPPORTED_ENGINE');
    expect(result.error?.message).toContain('MONGODB');
  });
});
