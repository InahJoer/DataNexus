import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { ConnectionsService } from '../connections/connections.service.js';
import {
  DATA_EXPLORER_FACTORY,
  type CatalogObject,
  type DataExplorer,
  type DataExplorerFactory,
} from './data-explorer.interface.js';

const EXPLORATION_TIMEOUT_MS = 10_000;

@Injectable()
export class DataEngineService {
  constructor(
    private readonly connectionsService: ConnectionsService,
    @Inject(DATA_EXPLORER_FACTORY) private readonly createExplorer: DataExplorerFactory,
  ) {}

  async exploreConnection(actor: AuthenticatedUser, connectionId: string) {
    const connection = await this.connectionsService.getConnectionForExploration(
      connectionId,
      actor.workspaceId,
    );

    const explorer = this.createExplorer(connection.tipoMotor);
    if (!explorer) throw new BadRequestException('Motor de base de datos no soportado');

    const deadline = Date.now() + EXPLORATION_TIMEOUT_MS;
    try {
      const objects = await this.withTimeout(
        explorer.listObjects(connection.connectionString, connection.dbName),
        deadline,
      );

      return {
        connectionId: connection.id,
        tipoMotor: connection.tipoMotor,
        objects: this.sanitizeObjects(objects),
      };
    } catch (error) {
      if (error instanceof GatewayTimeoutException) throw error;
      if (this.isTimeoutError(error)) {
        throw new GatewayTimeoutException('La exploración excedió el tiempo permitido');
      }
      throw new BadGatewayException('No fue posible explorar el esquema de la conexión');
    } finally {
      await this.closeWithinDeadline(explorer, deadline);
    }
  }

  private async withTimeout<T>(operation: Promise<T>, deadline: number): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new GatewayTimeoutException('La exploración excedió 10 segundos');
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => {
              reject(new GatewayTimeoutException('La exploración excedió 10 segundos'));
            },
            remainingMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async closeWithinDeadline(explorer: DataExplorer, deadline: number): Promise<void> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      void explorer.cancel().catch(() => undefined);
      return;
    }

    let cleanupTimedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const close = explorer.close().catch(() => undefined);
    await Promise.race([
      close,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          cleanupTimedOut = true;
          resolve();
        }, remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (cleanupTimedOut) void explorer.cancel().catch(() => undefined);
  }

  private sanitizeObjects(objects: CatalogObject[]): CatalogObject[] {
    return objects.map(({ name, type, schema }) => ({
      name,
      type,
      ...(schema ? { schema } : {}),
    }));
  }

  private isTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: string }).code;
    return (
      code === 'ETIMEDOUT' ||
      code === 'ETIMEOUT' ||
      code === 'ESOCKETTIMEDOUT' ||
      code === 'ER_QUERY_TIMEOUT' ||
      /timeout|deadline exceeded|maximum statement execution time exceeded/i.test(error.message)
    );
  }
}
