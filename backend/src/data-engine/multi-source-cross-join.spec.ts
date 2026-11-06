import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CrossJoinDto } from './dto/cross-join.dto.js';
import { resolveJoinPlan } from './join/resolve-join-plan.js';
import { DataEngineService } from './data-engine.service.js';
import { buildDataAccessAuditEvent } from './data-access-audit.js';
import type { AdapterRegistry } from './adapters/adapter-registry.js';
import type { ConnectionsService } from '../connections/connections.service.js';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';

const IDS = {
  erp: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
  app: 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e',
  logistica: 'c3d4e5f6-a7b8-4c9d-9e1f-3a4b5c6d7e8f',
};

/** Clientes (SQL Server) × pedidos (Firestore) × envíos (MongoDB): el ejemplo del issue #30. */
const multiPayload = (overrides: Record<string, unknown> = {}) => ({
  fuentes: [
    { alias: 'clientes', conexionId: IDS.erp, entidad: 'clientes', esquema: 'dbo', filtros: [{ campo: 'activo', operador: 'eq', valor: true }] },
    { alias: 'pedidos', conexionId: IDS.app, entidad: 'pedidos' },
    { alias: 'envios', conexionId: IDS.logistica, entidad: 'envios', filtros: [{ campo: 'pais', operador: 'eq', valor: 'NI' }] },
  ],
  relaciones: [
    { izquierda: 'clientes', derecha: 'pedidos', tipo: 'INNER', llaves: [{ izquierda: 'id', derecha: 'cliente_id' }] },
    {
      izquierda: 'pedidos',
      derecha: 'envios',
      tipo: 'LEFT',
      llaves: [
        { izquierda: 'numero', derecha: 'pedido' },
        { izquierda: 'cliente_id', derecha: 'cliente' },
      ],
    },
  ],
  ...overrides,
});

const legacyPayload = {
  conexionSqlId: IDS.erp,
  conexionNoSqlId: IDS.app,
  tablaSql: 'clientes',
  coleccionNoSql: 'pedidos',
  llaveSql: 'id',
  llaveNoSql: 'cliente_id',
};

const errorsOf = async (payload: Record<string, unknown>) =>
  (await validate(plainToInstance(CrossJoinDto, payload))).map((error) => error.property);

describe('CrossJoinDto: formato de N fuentes', () => {
  it('acepta 3 fuentes con relaciones INNER y LEFT y llaves compuestas', async () => {
    expect(await errorsOf(multiPayload())).toEqual([]);
  });

  it('sigue aceptando el formato original, ahora con tipoJoin', async () => {
    expect(await errorsOf(legacyPayload)).toEqual([]);
    expect(await errorsOf({ ...legacyPayload, tipoJoin: 'FULL' })).toEqual([]);
    expect(await errorsOf({ ...legacyPayload, tipoJoin: 'CROSS' })).toEqual(['tipoJoin']);
  });

  it('sin fuentes exige los campos del formato original', async () => {
    expect(await errorsOf({})).toEqual(
      expect.arrayContaining(['conexionSqlId', 'conexionNoSqlId', 'tablaSql', 'coleccionNoSql', 'llaveSql', 'llaveNoSql']),
    );
  });

  it('con fuentes no exige los campos originales pero sí las relaciones', async () => {
    expect(await errorsOf(multiPayload({ relaciones: undefined }))).toEqual(['relaciones']);
  });

  it.each([
    ['una sola fuente', { fuentes: [multiPayload().fuentes[0]] }, 'fuentes'],
    ['alias inválido', { fuentes: [{ ...multiPayload().fuentes[0], alias: 'con espacio' }, ...multiPayload().fuentes.slice(1)] }, 'fuentes'],
    ['conexión que no es UUID', { fuentes: [{ ...multiPayload().fuentes[0], conexionId: 'x' }, ...multiPayload().fuentes.slice(1)] }, 'fuentes'],
    [
      'tipo de join desconocido',
      { relaciones: [{ ...multiPayload().relaciones[0], tipo: 'CROSS' }, multiPayload().relaciones[1]] },
      'relaciones',
    ],
    [
      'más de tres llaves',
      { relaciones: [{ ...multiPayload().relaciones[0], llaves: Array(4).fill({ izquierda: 'a', derecha: 'b' }) }, multiPayload().relaciones[1]] },
      'relaciones',
    ],
  ])('rechaza %s', async (_reason, overrides, property) => {
    expect(await errorsOf(multiPayload(overrides))).toContain(property);
  });
});

describe('resolveJoinPlan', () => {
  it('convierte el formato original en dos fuentes con alias sql y nosql', () => {
    const plan = resolveJoinPlan({ ...legacyPayload, esquemaSql: 'dbo', tipoJoin: 'LEFT' } as CrossJoinDto);
    expect(plan.sources.map((s) => [s.alias, s.entidad, s.esquema])).toEqual([
      ['sql', 'clientes', 'dbo'],
      ['nosql', 'pedidos', undefined],
    ]);
    expect(plan.relations).toEqual([
      { izquierda: 'sql', derecha: 'nosql', tipo: 'LEFT', llaves: [{ izquierda: 'id', derecha: 'cliente_id' }] },
    ]);
  });

  it('rechaza mezclar los dos formatos', () => {
    expect(() => resolveJoinPlan({ ...multiPayload(), tablaSql: 'clientes' } as unknown as CrossJoinDto)).toThrow(
      /no ambos \(sobra: tablaSql\)/,
    );
  });

  it('rechaza el formato original incompleto', () => {
    expect(() => resolveJoinPlan({ ...legacyPayload, llaveNoSql: undefined } as unknown as CrossJoinDto)).toThrow(
      BadRequestException,
    );
  });

  it('usa INNER cuando la relación no indica tipo', () => {
    const payload = multiPayload();
    delete (payload.relaciones[0] as { tipo?: string }).tipo;
    expect(resolveJoinPlan(payload as unknown as CrossJoinDto).relations[0].tipo).toBe('INNER');
  });
});

describe('DataEngineService con N fuentes', () => {
  const records: Record<string, Record<string, any>[]> = {
    clientes: [
      { id: 1, nombre: 'Ana', email: 'ana@corp.com' },
      { id: 2, nombre: 'Luis', email: 'luis@corp.com' },
    ],
    pedidos: [
      { numero: 'P1', cliente_id: 1, total: 120 },
      { numero: 'P2', cliente_id: 1, total: 80 },
      { numero: 'P3', cliente_id: 2, total: 50 },
    ],
    envios: [{ pedido: 'P1', cliente: 1, estado: 'entregado', pais: 'NI' }],
  };

  const setup = () => {
    const extract = vi.fn(async (_connection: unknown, entity: string) => records[entity].map((row) => ({ ...row })));
    const registry = {
      get: vi.fn(() => ({ tipoMotor: 'X', capabilities: { explore: true, fields: true, extract: true }, extract })),
    } as unknown as AdapterRegistry;
    const getConnectionForExploration = vi.fn(async (id: string) => ({ id, tipoMotor: 'X', dbName: 'd', connectionString: 's' }));
    const service = new DataEngineService({ getConnectionForExploration } as unknown as ConnectionsService, registry);
    return { service, extract, getConnectionForExploration };
  };
  const user = (role: string) => ({ id: 'u', email: 'u@corp.com', name: 'U', role, workspaceId: 'ws-1' }) as AuthenticatedUser;

  it('extrae cada fuente una vez con sus filtros y une INNER + LEFT con llave compuesta', async () => {
    const { service, extract, getConnectionForExploration } = setup();
    const result = await service.executeCrossJoin(multiPayload() as unknown as CrossJoinDto, user('ADMIN'));

    expect(extract).toHaveBeenCalledTimes(3);
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.erp }), 'clientes', {
      schema: 'dbo',
      filters: [{ campo: 'activo', operador: 'eq', valor: true }],
    });
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.app }), 'pedidos', undefined);
    expect(getConnectionForExploration).toHaveBeenCalledTimes(3);
    expect(getConnectionForExploration).toHaveBeenCalledWith(IDS.erp, 'ws-1');

    expect(result.total).toBe(3);
    expect(result.data.map((row) => [row.nombre, row.numero, row.estado])).toEqual([
      ['Ana', 'P1', 'entregado'],
      ['Ana', 'P2', null],
      ['Luis', 'P3', null],
    ]);
  });

  it('busca una sola vez una conexión usada por varias fuentes', async () => {
    const { service, getConnectionForExploration } = setup();
    const payload = multiPayload();
    payload.fuentes[2].conexionId = IDS.erp;
    await service.executeCrossJoin(payload as unknown as CrossJoinDto, user('ADMIN'));
    expect(getConnectionForExploration).toHaveBeenCalledTimes(2);
  });

  it('enmascara los campos sensibles para LECTOR y agrupa por campos unificados', async () => {
    const { service } = setup();
    const masked = await service.executeCrossJoin(multiPayload() as unknown as CrossJoinDto, user('LECTOR'));
    for (const row of masked.data) expect(row.email).not.toMatch(/^[a-z]+@corp\.com$/);

    const grouped = await service.executeCrossJoin(
      multiPayload({ groupBy: ['nombre'], aggregations: [{ operation: 'SUM', field: 'total', as: 'ventas' }] }) as unknown as CrossJoinDto,
      user('ADMIN'),
    );
    expect(grouped.data).toEqual([
      { nombre: 'Ana', ventas: 200 },
      { nombre: 'Luis', ventas: 50 },
    ]);
  });

  it('responde 400 si el plan no es válido, antes de tocar las fuentes', async () => {
    const { service, extract } = setup();
    const payload = multiPayload();
    payload.relaciones[1].derecha = 'clientes';
    await expect(service.executeCrossJoin(payload as unknown as CrossJoinDto, user('ADMIN'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(extract).not.toHaveBeenCalled();
  });
});

describe('Bitácora de un cross-join de N fuentes', () => {
  it('registra entidades, conexiones y tipos de join, sin valores de filtros', () => {
    const request = {
      user: { id: 'u1', email: 'u1@corp.com', name: 'U1', role: 'LECTOR', workspaceId: 'ws-1' },
      ip: '203.0.113.9',
      get: () => 'vitest',
    } as unknown as AuthenticatedRequest;
    const event = buildDataAccessAuditEvent('EXECUTE_JOIN', request, multiPayload() as unknown as CrossJoinDto, {
      totalFilas: 3,
    });

    expect(event.targetId).toBe('dbo.clientes x pedidos x envios');
    expect(event.details).toEqual({
      entidades: 'dbo.clientes x pedidos x envios',
      conexiones: `${IDS.erp},${IDS.app},${IDS.logistica}`,
      fuentes: 3,
      tiposJoin: 'INNER,LEFT',
      filtros: 2,
      agregado: false,
      enmascarado: true,
      totalFilas: 3,
    });
    expect(JSON.stringify(event)).not.toContain('NI');
  });
});
