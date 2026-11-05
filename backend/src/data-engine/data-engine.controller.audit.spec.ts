import { describe, expect, it, vi } from 'vitest';
import { BadGatewayException } from '@nestjs/common';
import type { Response } from 'express';
import { DataEngineController } from './data-engine.controller.js';
import type { DataEngineService } from './data-engine.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import type { CrossJoinDto, ExportCrossJoinDto } from './dto/cross-join.dto.js';
import type { AuditEventInput } from '../audit/audit.types.js';

const request = (role: 'ADMIN' | 'LECTOR' = 'ADMIN') =>
  ({
    user: { id: 'u1', email: 'u1@corp.com', name: 'U1', role, workspaceId: 'ws-1' },
    ip: '203.0.113.9',
    get: (header: string) => (header === 'user-agent' ? 'vitest-agent' : undefined),
  }) as unknown as AuthenticatedRequest;

const payload = {
  conexionSqlId: 'sql-1',
  conexionNoSqlId: 'nosql-1',
  esquemaSql: 'dbo',
  tablaSql: 'clientes',
  coleccionNoSql: 'pedidos',
  llaveSql: 'id',
  llaveNoSql: 'clienteId',
  filtrosSql: [{ campo: 'email', operador: 'eq', valor: 'secreto@corp.com' }],
} as unknown as CrossJoinDto;

function setup(engine: Partial<Record<keyof DataEngineService, unknown>>) {
  const record = vi.fn<(input: AuditEventInput) => Promise<void>>().mockResolvedValue();
  const controller = new DataEngineController(
    engine as unknown as DataEngineService,
    { record } as unknown as AuditService,
  );
  return { controller, record };
}

describe('DataEngineController: bitácora de accesos a datos', () => {
  it('registra EXECUTE_JOIN con tabla, colección, IP y total de filas, sin valores de filtros', async () => {
    const { controller, record } = setup({
      executeCrossJoin: vi.fn().mockResolvedValue({ total: 7, limit: 50, offset: 0, data: [] }),
    });

    await controller.crossJoin(request(), payload);

    const event = record.mock.calls[0][0];
    expect(event).toMatchObject({
      eventType: 'EXECUTE_JOIN',
      outcome: 'SUCCESS',
      actorUserId: 'u1',
      workspaceId: 'ws-1',
      targetType: 'CROSS_JOIN',
      targetId: 'dbo.clientes x pedidos',
      ipAddress: '203.0.113.9',
      userAgent: 'vitest-agent',
      details: expect.objectContaining({ totalFilas: 7, filtrosSql: 1, enmascarado: false }),
    });
    expect(JSON.stringify(event)).not.toContain('secreto@corp.com');
  });

  it('registra el intento fallido y propaga el error original', async () => {
    const failure = new BadGatewayException('fuente caída');
    const { controller, record } = setup({ executeCrossJoin: vi.fn().mockRejectedValue(failure) });

    await expect(controller.crossJoin(request('LECTOR'), payload)).rejects.toBe(failure);
    expect(record.mock.calls[0][0]).toMatchObject({
      eventType: 'EXECUTE_JOIN',
      outcome: 'FAILURE',
      details: expect.objectContaining({ error: '502 BadGatewayException', enmascarado: true }),
    });
  });

  it('si la bitácora falla al registrar un error, el cliente recibe el error original', async () => {
    const failure = new BadGatewayException('fuente caída');
    const { controller, record } = setup({ executeCrossJoin: vi.fn().mockRejectedValue(failure) });
    record.mockRejectedValue(new Error('db caída'));

    await expect(controller.crossJoin(request(), payload)).rejects.toBe(failure);
  });

  it('registra EXPORT con el formato y las filas exportadas', async () => {
    const { controller, record } = setup({
      executeCrossJoinForExport: vi.fn().mockResolvedValue({
        buffer: Buffer.from('{}'),
        contentType: 'application/json',
        filename: 'x.json',
        totalRows: 3,
      }),
    });
    const res = { set: vi.fn(), end: vi.fn() } as unknown as Response;

    await controller.exportJoin(request(), { ...payload, format: 'json' } as ExportCrossJoinDto, res);

    expect(record.mock.calls[0][0]).toMatchObject({
      eventType: 'EXPORT',
      outcome: 'SUCCESS',
      details: expect.objectContaining({ formato: 'json', totalFilas: 3 }),
    });
    expect(res.end).toHaveBeenCalled();
  });
});
