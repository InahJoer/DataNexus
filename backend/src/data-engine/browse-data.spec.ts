import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataEngineService } from './data-engine.service.js';
import { DataEngineController } from './data-engine.controller.js';
import { BrowseDataQueryDto } from './dto/browse-data.dto.js';
import { cursorBinding, encodeCursor, type DataPageOptions } from './pagination/keyset.js';
import type { AdapterRegistry } from './adapters/adapter-registry.js';
import type { ConnectionsService } from '../connections/connections.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import type { AuditEventInput } from '../audit/audit.types.js';
import type { DataFilter } from './filters/filter-tree.js';

const CONN = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
const user = (role = 'ADMIN') => ({ id: 'u1', email: 'u1@corp.com', name: 'U', role, workspaceId: 'ws-1' }) as AuthenticatedUser;

function setup(overrides: Record<string, unknown> = {}) {
  const readPage = vi.fn(async (_connection: unknown, _entity: string, options: DataPageOptions) => ({
    rows: [
      { id: 1, nombre: 'Ana', email: 'ana@corp.com', canal: 'web' },
      { id: 2, nombre: 'Luis', email: 'luis@corp.com', canal: 'tienda' },
    ],
    orderBy: ['id'],
    lastKey: options.after ? null : [2],
  }));
  const adapter = { tipoMotor: 'POSTGRESQL', capabilities: { explore: true, fields: true, extract: true }, readPage, ...overrides };
  const registry = { get: vi.fn(() => adapter) } as unknown as AdapterRegistry;
  const lookup = vi.fn(async (id: string) => ({ id, tipoMotor: 'POSTGRESQL', dbName: 'd', connectionString: 's' }));
  const connections = { getConnectionForExploration: lookup } as unknown as ConnectionsService;
  return { service: new DataEngineService(connections, registry), readPage, lookup };
}

const query = (extra: Partial<BrowseDataQueryDto> = {}) => ({ entidad: 'clientes', limite: 2, ...extra }) as BrowseDataQueryDto;

describe('DataEngineService.browseData (issue #32)', () => {
  it('devuelve la página, las columnas de orden y un cursor opaco para la siguiente', async () => {
    const { service, readPage } = setup();
    const first = await service.browseData(user(), CONN, query({ esquema: 'public' }));
    expect(first).toMatchObject({ entidad: 'clientes', esquema: 'public', limite: 2, orden: ['id'], filas: 2 });
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readPage).toHaveBeenCalledWith(expect.objectContaining({ id: CONN }), 'clientes', { schema: 'public', pageSize: 2 });

    const second = await service.browseData(user(), CONN, query({ esquema: 'public', cursor: first.nextCursor! }));
    expect(readPage).toHaveBeenLastCalledWith(expect.anything(), 'clientes', { schema: 'public', pageSize: 2, after: [2] });
    expect(second.nextCursor).toBeNull();
  });

  it('rechaza el cursor de otra tabla antes de consultar la fuente', async () => {
    const { service, readPage, lookup } = setup();
    const foreign = encodeCursor(cursorBinding(CONN, 'pedidos'), [2]);
    await expect(service.browseData(user(), CONN, query({ cursor: foreign }))).rejects.toThrow(/cursor no es válido/);
    expect(readPage).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('valida los filtros del query string y aplica en memoria los que el motor no ejecuta', async () => {
    const { service, readPage } = setup({ canPushDown: (filter: DataFilter) => filter.operador !== 'contains' });
    const result = await service.browseData(
      user(),
      CONN,
      query({
        filtros: JSON.stringify([
          { campo: 'nombre', operador: 'neq', valor: 'X' },
          { campo: 'canal', operador: 'contains', valor: 'WE' },
        ]),
      }),
    );
    expect(readPage.mock.calls[0][2].filters).toEqual([{ campo: 'nombre', operador: 'neq', valor: 'X' }]);
    expect(result.data.map((row) => row.id)).toEqual([1]);

    await expect(service.browseData(user(), CONN, query({ filtros: '{no json' }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.browseData(user(), CONN, query({ filtros: JSON.stringify([{ campo: 'a', operador: 'between', valor: [9, 1] }]) })),
    ).rejects.toThrow(/mínimo no puede ser mayor/);
  });

  it('enmascara los datos sensibles para roles sin VIEW_UNMASKED_DATA', async () => {
    const { service } = setup();
    const result = await service.browseData(user('LECTOR'), CONN, query());
    for (const row of result.data) expect(row.email).not.toMatch(/^[a-z]+@corp\.com$/);
  });

  it('un motor sin paginación responde 400 y un error del driver, 502 sin detalles', async () => {
    await expect(setup({ readPage: undefined }).service.browseData(user(), CONN, query())).rejects.toThrow(
      /no está disponible para este motor/,
    );
    const failing = setup({ readPage: vi.fn().mockRejectedValue(new Error('password authentication failed for user x')) });
    await expect(failing.service.browseData(user(), CONN, query())).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('BrowseDataQueryDto', () => {
  const errors = async (plain: Record<string, unknown>) =>
    (await validate(plainToInstance(BrowseDataQueryDto, plain))).map((error) => error.property);

  it('acepta una consulta válida y usa 50 filas por defecto', async () => {
    const dto = plainToInstance(BrowseDataQueryDto, { entidad: 'clientes', limite: '100' });
    expect(await validate(dto)).toEqual([]);
    expect(dto.limite).toBe(100);
    expect(plainToInstance(BrowseDataQueryDto, { entidad: 'x' }).limite).toBe(50);
  });

  it.each([
    [{ entidad: '' }, 'entidad'],
    [{ entidad: 'x', limite: 0 }, 'limite'],
    [{ entidad: 'x', limite: 1001 }, 'limite'],
    [{ entidad: 'x', cursor: 'abc$def' }, 'cursor'],
    [{ entidad: 'x', filtros: 'x'.repeat(4001) }, 'filtros'],
  ])('rechaza %j', async (plain, property) => {
    expect(await errors(plain)).toContain(property);
  });
});

describe('GET /engine/connections/:id/data: bitácora', () => {
  const request = {
    user: user('LECTOR'),
    ip: '203.0.113.9',
    get: () => 'vitest',
  } as unknown as AuthenticatedRequest;

  const controllerWith = (browseData: unknown) => {
    const record = vi.fn<(event: AuditEventInput) => Promise<void>>().mockResolvedValue();
    const controller = new DataEngineController({ browseData } as never, { record } as unknown as AuditService);
    return { controller, record };
  };

  it('registra BROWSE_DATA solo en la primera página de cada recorrido, sin valores de filtros', async () => {
    const { controller, record } = controllerWith(vi.fn().mockResolvedValue({ filas: 2, nextCursor: 'abc' }));
    const filtros = JSON.stringify([{ campo: 'pais', operador: 'eq', valor: 'NI' }]);
    await controller.browseData(request, CONN, query({ esquema: 'public', filtros }));
    await controller.browseData(request, CONN, query({ esquema: 'public', filtros, cursor: 'abc' }));

    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({
      eventType: 'BROWSE_DATA',
      outcome: 'SUCCESS',
      targetType: 'CONNECTION',
      targetId: CONN,
      details: { entidad: 'public.clientes', limite: 2, filtros: 1, filas: 2, enmascarado: true },
    });
    expect(JSON.stringify(record.mock.calls[0][0])).not.toContain('NI');
  });

  it('registra los fallos y devuelve el error original', async () => {
    const { controller, record } = controllerWith(vi.fn().mockRejectedValue(new BadRequestException('sin llave primaria')));
    await expect(controller.browseData(request, CONN, query({ cursor: 'abc' }))).rejects.toBeInstanceOf(BadRequestException);
    expect(record.mock.calls[0][0]).toMatchObject({ eventType: 'BROWSE_DATA', outcome: 'FAILURE' });
  });
});
