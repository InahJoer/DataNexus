import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CrossJoinDto } from './dto/cross-join.dto.js';
import { DataEngineService } from './data-engine.service.js';
import { buildDataAccessAuditEvent } from './data-access-audit.js';
import type { AdapterRegistry } from './adapters/adapter-registry.js';
import type { ConnectionsService } from '../connections/connections.service.js';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import type { DataFilter } from './filters/filter-tree.js';

const SQL_ID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
const FS_ID = 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e';

const clientes = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, nombre: i % 2 ? `Ana ${i}` : `Luis ${i}`, pais: i < 4 ? 'NI' : 'CR' }));
const pedidos = Array.from({ length: 8 }, (_, i) => ({ cliente_id: i + 1, estado: i % 3 ? 'pagado' : 'pendiente', canal: i % 2 ? 'web' : 'tienda' }));

/** Motor con un adaptador SQL (lo ejecuta todo) y uno tipo Firestore (sin texto ni grupos). */
function setup() {
  const sqlExtract = vi.fn(async () => clientes.map((row) => ({ ...row })));
  const fsExtract = vi.fn(async () => pedidos.map((row) => ({ ...row })));
  const adapters: Record<string, unknown> = {
    POSTGRESQL: { tipoMotor: 'POSTGRESQL', capabilities: { explore: true, fields: true, extract: true }, extract: sqlExtract },
    FIRESTORE: {
      tipoMotor: 'FIRESTORE',
      capabilities: { explore: true, fields: true, extract: true },
      pushesFilterGroups: false,
      canPushDown: (filter: DataFilter) => !['contains', 'startsWith'].includes(filter.operador),
      extract: fsExtract,
    },
  };
  const registry = { get: vi.fn((motor: string) => adapters[motor]) } as unknown as AdapterRegistry;
  const connections = {
    getConnectionForExploration: vi.fn(async (id: string) => ({
      id,
      tipoMotor: id === SQL_ID ? 'POSTGRESQL' : 'FIRESTORE',
      dbName: 'd',
      connectionString: 's',
    })),
  } as unknown as ConnectionsService;
  return { service: new DataEngineService(connections, registry), sqlExtract, fsExtract };
}

const admin = { id: 'u', email: 'u@corp.com', name: 'U', role: 'ADMIN', workspaceId: 'ws-1' } as AuthenticatedUser;

const payload = (overrides: Record<string, unknown> = {}) =>
  ({
    conexionSqlId: SQL_ID,
    conexionNoSqlId: FS_ID,
    tablaSql: 'clientes',
    coleccionNoSql: 'pedidos',
    llaveSql: 'id',
    llaveNoSql: 'cliente_id',
    filtrosSql: [
      { campo: 'pais', operador: 'eq', valor: 'NI' },
      { logica: 'OR', filtros: [{ campo: 'nombre', operador: 'startsWith', valor: 'ana' }, { campo: 'id', operador: 'eq', valor: 4 }] },
    ],
    filtrosNoSql: [
      { campo: 'estado', operador: 'eq', valor: 'pagado' },
      { campo: 'canal', operador: 'contains', valor: 'WE' },
    ],
    ...overrides,
  }) as unknown as CrossJoinDto;

describe('Filter pushdown y evaluación en memoria (issue #31)', () => {
  it('el motor SQL recibe todos sus filtros (grupos incluidos); a Firestore solo le llega lo que soporta', async () => {
    const { service, sqlExtract, fsExtract } = setup();
    await service.executeCrossJoin(payload(), admin);

    expect(sqlExtract).toHaveBeenCalledWith(expect.anything(), 'clientes', { filters: payload().filtrosSql });
    expect(fsExtract).toHaveBeenCalledWith(expect.anything(), 'pedidos', {
      filters: [{ campo: 'estado', operador: 'eq', valor: 'pagado' }],
    });
  });

  it('aplica en memoria lo que Firestore no puede ejecutar', async () => {
    const { service } = setup();
    const result = await service.executeCrossJoin(payload(), admin);
    // Los adaptadores simulados no filtran: solo pasan las filas que cumplen también los filtros en memoria del motor.
    const ids = result.data.map((row) => row.id);
    for (const row of result.data) {
      expect(row.canal).toBe('web');
    }
    expect(ids.length).toBeGreaterThan(0);
  });

  it('un grupo OR en la colección se evalúa entero en memoria', async () => {
    const { service, fsExtract } = setup();
    const result = await service.executeCrossJoin(
      payload({
        filtrosSql: undefined,
        filtrosNoSql: [
          {
            logica: 'OR',
            filtros: [
              { campo: 'estado', operador: 'eq', valor: 'pendiente' },
              { campo: 'canal', operador: 'eq', valor: 'tienda' },
            ],
          },
        ],
      }),
      admin,
    );
    expect(fsExtract).toHaveBeenCalledWith(expect.anything(), 'pedidos', undefined);
    expect(result.data.every((row) => row.estado === 'pendiente' || row.canal === 'tienda')).toBe(true);
    expect(result.total).toBe(pedidos.filter((row) => row.estado === 'pendiente' || row.canal === 'tienda').length);
  });
});

describe('limiteFilas (RF-16)', () => {
  it('limita el resultado y avisa si se truncó', async () => {
    const { service } = setup();
    const base = { filtrosSql: undefined, filtrosNoSql: undefined };
    const limited = await service.executeCrossJoin(payload({ ...base, limiteFilas: 50 }), admin);
    expect(limited).toMatchObject({ total: 8, limiteFilas: 50, truncado: false });

    vi.stubEnv('DATA_ENGINE_MAX_JOIN_ROWS', '100000');
    const many = setup();
    const bigSql = Array.from({ length: 120 }, (_, i) => ({ id: i, nombre: 'x', pais: 'NI' }));
    const bigFs = Array.from({ length: 120 }, (_, i) => ({ cliente_id: i, estado: 'pagado', canal: 'web' }));
    many.sqlExtract.mockResolvedValue(bigSql);
    many.fsExtract.mockResolvedValue(bigFs);
    const truncated = await many.service.executeCrossJoin(payload({ ...base, limiteFilas: 100, limit: 1000 }), admin);
    expect(truncated).toMatchObject({ total: 100, limiteFilas: 100, truncado: true });
    expect(truncated.data).toHaveLength(100);
    vi.unstubAllEnvs();
  });

  it('sin limiteFilas la respuesta no cambia', async () => {
    const { service } = setup();
    const result = await service.executeCrossJoin(payload({ filtrosSql: undefined, filtrosNoSql: undefined }), admin);
    expect(result).not.toHaveProperty('limiteFilas');
    expect(result).not.toHaveProperty('truncado');
  });
});

describe('CrossJoinDto con filtros avanzados', () => {
  const errors = async (overrides: Record<string, unknown>) => {
    const found = await validate(plainToInstance(CrossJoinDto, { ...(payload() as object), ...overrides }));
    return found.map((error) => [error.property, Object.values(error.constraints ?? {}).join(' ')]);
  };

  it('acepta grupos, between, contains, startsWith e isNull', async () => {
    expect(
      await errors({
        filtrosSql: [
          { campo: 'alta', operador: 'between', valor: ['2026-01-01', '2026-12-31'] },
          { campo: 'baja', operador: 'isNull', valor: true },
          { logica: 'OR', filtros: [{ campo: 'nombre', operador: 'contains', valor: 'ana' }] },
        ],
        limiteFilas: 500,
      }),
    ).toEqual([]);
  });

  it('responde con un mensaje claro para filtros no válidos', async () => {
    expect(await errors({ filtrosSql: [{ campo: 'total', operador: 'between', valor: [10, 1] }] })).toEqual([
      ['filtrosSql', 'filtrosSql: en between el mínimo no puede ser mayor que el máximo'],
    ]);
  });

  it('limiteFilas solo admite 50, 100, 500 o 1000', async () => {
    expect(await errors({ limiteFilas: 75 })).toEqual([['limiteFilas', 'limiteFilas debe ser uno de: 50, 100, 500, 1000']]);
    expect(await errors({ limiteFilas: '1000' })).toEqual([]);
  });

  it('valida igual los filtros del formato de N fuentes', async () => {
    const multi = {
      fuentes: [
        { alias: 'a', conexionId: SQL_ID, entidad: 'clientes', filtros: [{ logica: 'XOR', filtros: [] }] },
        { alias: 'b', conexionId: FS_ID, entidad: 'pedidos' },
      ],
      relaciones: [{ izquierda: 'a', derecha: 'b', llaves: [{ izquierda: 'id', derecha: 'cliente_id' }] }],
    };
    const found = await validate(plainToInstance(CrossJoinDto, multi));
    expect(JSON.stringify(found)).toContain('logica debe ser AND u OR');
  });
});

describe('Bitácora', () => {
  it('cuenta las condiciones dentro de los grupos y no guarda sus valores', () => {
    const request = {
      user: { id: 'u1', email: 'u1@corp.com', name: 'U1', role: 'ADMIN', workspaceId: 'ws-1' },
      ip: '203.0.113.9',
      get: () => 'vitest',
    } as unknown as AuthenticatedRequest;
    const event = buildDataAccessAuditEvent('EXECUTE_JOIN', request, payload(), { totalFilas: 2 });
    expect(event.details).toMatchObject({ filtrosSql: 3, filtrosNoSql: 2 });
    expect(JSON.stringify(event)).not.toContain('pagado');
  });
});
