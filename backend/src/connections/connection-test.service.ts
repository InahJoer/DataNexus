import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { ConnectionsService } from './connections.service.js';
import type { ConnectionTestResultDto } from './dto/connection-test-result.dto.js';
import {
  MAX_CONNECTION_TEST_TIMEOUT_MS,
  MIN_CONNECTION_TEST_TIMEOUT_MS,
  type ConnectionTestOptionsDto,
  type TestConnectionDto,
} from './dto/test-connection.dto.js';
import {
  CONNECTION_TESTER_FACTORY,
  type ConnectionTesterFactory,
} from './testing/connection-tester.interface.js';
import { connectionError, normalizeConnectionError } from './testing/connection-error.normalizer.js';
import {
  describeCredentials,
  serializeCredentials,
  toDriverConnectionString,
  validateCredentials,
} from './credentials/connection-credentials.js';

const DEFAULT_TIMEOUT_MS = 10_000;

class ConnectionTestTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
}

/** Tiempo máximo por defecto, configurable con CONNECTION_TEST_TIMEOUT_MS. */
export function getDefaultConnectionTestTimeoutMs(): number {
  const value = Number(process.env.CONNECTION_TEST_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(value, MIN_CONNECTION_TEST_TIMEOUT_MS), MAX_CONNECTION_TEST_TIMEOUT_MS);
}

/** RF-10: probar una conexión y medir su latencia sin persistir nada. */
@Injectable()
export class ConnectionTestService {
  constructor(
    private readonly connectionsService: ConnectionsService,
    @Inject(CONNECTION_TESTER_FACTORY)
    private readonly createTester: ConnectionTesterFactory,
  ) {}

  /**
   * Prueba credenciales estructuradas enviadas en el cuerpo (mismo formato que el alta). Se validan con el
   * DTO del motor (400 si no son válidas) y se traducen al formato del driver sin guardarlas.
   */
  async testCredentials(input: TestConnectionDto): Promise<ConnectionTestResultDto> {
    const credentials = await validateCredentials(input.tipoMotor, input.credenciales);
    const connectionString = toDriverConnectionString(serializeCredentials(input.tipoMotor, credentials));
    const { dbName } = describeCredentials(input.tipoMotor, credentials);
    return this.run(input.tipoMotor, connectionString, dbName, input.timeoutMs);
  }

  /** Prueba una conexión guardada del workspace. Lanza 404 si no le pertenece. */
  async testSaved(
    actor: AuthenticatedUser,
    id: string,
    options: ConnectionTestOptionsDto = {},
  ): Promise<ConnectionTestResultDto> {
    const connection = await this.connectionsService.getConnectionForExploration(id, actor.workspaceId);
    return this.run(
      connection.tipoMotor,
      connection.connectionString,
      connection.dbName,
      options.timeoutMs,
    );
  }

  private async run(
    tipoMotor: string,
    connectionString: string,
    dbName: string,
    requestedTimeoutMs?: number,
  ): Promise<ConnectionTestResultDto> {
    const timeoutMs = requestedTimeoutMs ?? getDefaultConnectionTestTimeoutMs();
    const tester = this.createTester(tipoMotor);
    if (!tester) {
      return this.failure(connectionError('UNSUPPORTED_ENGINE', tipoMotor));
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = performance.now();
    try {
      const { serverVersion } = await Promise.race([
        tester.ping(connectionString, dbName, timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ConnectionTestTimeoutError()), timeoutMs);
        }),
      ]);
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - startedAt),
        serverVersion,
        error: null,
      };
    } catch (error) {
      return this.failure(normalizeConnectionError(error, tipoMotor, timeoutMs));
    } finally {
      if (timer) clearTimeout(timer);
      // No bloquea la respuesta si el driver tarda en cerrar.
      void tester.close().catch(() => undefined);
    }
  }

  private failure(error: ConnectionTestResultDto['error']): ConnectionTestResultDto {
    return { ok: false, latencyMs: null, serverVersion: null, error };
  }
}
