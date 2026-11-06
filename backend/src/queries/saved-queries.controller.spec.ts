import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { CrossJoinDto } from '../data-engine/dto/cross-join.dto.js';
import { SavedQueriesController } from './saved-queries.controller.js';
import type { PreparedSavedQueryRun, SavedQueriesService } from './saved-queries.service.js';

const request = {
  user: { id: 'lector-1', email: 'lector@empresa.com', name: 'Lector', role: 'LECTOR', workspaceId: 'ws-1' },
  ip: '10.0.0.1',
  get: () => 'vitest',
} as unknown as AuthenticatedRequest;

const prepared: PreparedSavedQueryRun = {
  payload: plainToInstance(CrossJoinDto, {
    conexionSqlId: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
    conexionNoSqlId: 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e',
    tablaSql: 'clients',
    coleccionNoSql: 'orders',
    llaveSql: 'id',
    llaveNoSql: 'client_id',
  }),
  query: { id: 'query-1', nombre: 'Clientes y pedidos' },
  version: 2,
};

function setup(execute: SavedQueriesService['execute']) {
  const savedQueries = { prepareRun: vi.fn().mockResolvedValue(prepared), execute: vi.fn(execute) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new SavedQueriesController(
    savedQueries as unknown as SavedQueriesService,
    audit as unknown as AuditService,
  );
  return { controller, savedQueries, audit };
}

describe('POST /queries/:id/run – bitácora', () => {
  it('registra EXECUTE_JOIN con la consulta y versión de origen', async () => {
    const { controller, audit } = setup(async () => ({
      total: 3, limit: 50, offset: 0, data: [], consultaId: 'query-1', version: 2,
    }));

    await controller.run(request, 'query-1', {});

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'EXECUTE_JOIN',
        outcome: 'SUCCESS',
        targetType: 'CROSS_JOIN',
        actorUserId: 'lector-1',
        details: expect.objectContaining({
          totalFilas: 3,
          enmascarado: true,
          consultaGuardadaId: 'query-1',
          consultaGuardada: 'Clientes y pedidos',
          version: 2,
        }),
      }),
    );
  });

  it('registra el fallo de la extracción y devuelve el error original', async () => {
    const failure = new BadGatewayException('fuente caída');
    const { controller, audit } = setup(async () => {
      throw failure;
    });

    await expect(controller.run(request, 'query-1', {})).rejects.toBe(failure);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILURE', details: expect.objectContaining({ consultaGuardadaId: 'query-1' }) }),
    );
  });

  it('no registra nada si la consulta no existe o no es visible', async () => {
    const { controller, savedQueries, audit } = setup(async () => {
      throw new Error('no debería ejecutarse');
    });
    savedQueries.prepareRun.mockRejectedValue(new NotFoundException());

    await expect(controller.run(request, 'query-1', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(savedQueries.execute).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
