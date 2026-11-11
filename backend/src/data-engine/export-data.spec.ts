import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataEngineService } from './data-engine.service.js';
import { ExportDataDto } from './dto/export-data.dto.js';
import { CrossJoinDto } from './dto/cross-join.dto.js';
import { ExportService, csvCell } from './export/export.service.js';
import type { DataPageOptions } from './pagination/keyset.js';
import type { AdapterRegistry } from './adapters/adapter-registry.js';
import type { ConnectionsService } from '../connections/connections.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';

const CONN = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
const user = (role = 'ADMIN') => ({ id: 'u1', email: 'u1@corp.com', name: 'U', role, workspaceId: 'ws-1' }) as AuthenticatedUser;

/** Tabla de 5 filas que el adaptador entrega de 2 en 2 (aunque se pidan más), para probar el recorrido por páginas. */
function setup() {
  const all = [
    { id: 1, nombre: 'Ana', ciudad: 'León', total: 10, envio: { tipo: 'express' } },
    { id: 2, nombre: 'Luis', ciudad: 'Managua', total: 40, envio: null },
    { id: 3, nombre: '=SUMA(A1)', ciudad: 'Managua', total: 25, envio: null },
    { id: 4, nombre: 'Rosa', ciudad: 'Masaya', total: 5, envio: null },
    { id: 5, nombre: 'Juan', ciudad: 'Managua', total: 60, envio: null },
  ];
  const readPage = vi.fn(async (_connection: unknown, _entity: string, options: DataPageOptions) => {
    const start = options.after ? Number(options.after[0]) : 0;
    const rows = all.slice(start, start + 2);
    return { rows, orderBy: ['id'], lastKey: start + 2 < all.length ? [start + 2] : null };
  });
  // Sin pushdown: los filtros se aplican en memoria sobre cada página (como en un motor que no los soporta).
  const adapter = { tipoMotor: 'POSTGRESQL', capabilities: { explore: true, fields: true, extract: true }, readPage, canPushDown: () => false };
  const registry = { get: vi.fn(() => adapter) } as unknown as AdapterRegistry;
  const connections = {
    getConnectionForExploration: vi.fn(async (id: string) => ({ id, tipoMotor: 'POSTGRESQL', dbName: 'd', connectionString: 's' })),
  } as unknown as ConnectionsService;
  return { service: new DataEngineService(connections, registry), readPage };
}

const body = (extra: Partial<ExportDataDto> = {}) => ({ conexionId: CONN, entidad: 'clientes', format: 'csv', ...extra }) as ExportDataDto;
const csvLines = (buffer: Buffer) => buffer.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');

describe('DataEngineService.exportData (explorador → Excel/CSV)', () => {
  it('recorre todas las páginas y exporta las columnas visibles, en orden, con su encabezado', async () => {
    const { service, readPage } = setup();
    const file = await service.exportData(
      user(),
      body({
        filtros: [{ campo: 'ciudad', operador: 'eq', valor: 'Managua' }],
        ordenarPor: [{ campo: 'total', direccion: 'DESC' }],
        columnas: ['nombre', 'total'],
        aliasColumnas: { nombre: 'Cliente' },
      }),
    );
    expect(readPage).toHaveBeenCalledTimes(3);
    expect(file).toMatchObject({ contentType: 'text/csv; charset=utf-8', totalRows: 3, truncated: false });
    expect(file.filename).toMatch(/^clientes_.*\.csv$/);
    expect(csvLines(file.buffer)).toEqual(['Cliente,total', 'Juan,60', 'Luis,40', "'=SUMA(A1),25"]);
  });

  it('se detiene en limiteFilas e indica que el archivo quedó recortado', async () => {
    const { service, readPage } = setup();
    const file = await service.exportData(user(), body({ limiteFilas: 3 }));
    expect(file).toMatchObject({ totalRows: 3, truncated: true });
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('genera Excel con los objetos anidados como texto', async () => {
    const { service } = setup();
    const file = await service.exportData(user(), body({ format: 'excel' }));
    expect(file.filename).toMatch(/\.xlsx$/);
    expect(file.buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('valida el cuerpo: formato conocido y límite de filas', async () => {
    const errors = await validate(plainToInstance(ExportDataDto, { conexionId: CONN, entidad: 'x', format: 'zip', limiteFilas: 50_000 }));
    expect(errors.map((error) => error.property).sort()).toEqual(['format', 'limiteFilas']);
  });
});

describe('Filtros sobre la tabla combinada (filtrosResultado)', () => {
  it('se validan como los filtros de una fuente', async () => {
    const dto = plainToInstance(CrossJoinDto, {
      fuentes: [
        { alias: 'a', conexionId: CONN, entidad: 'x' },
        { alias: 'b', conexionId: CONN, entidad: 'y' },
      ],
      relaciones: [{ izquierda: 'a', derecha: 'b', llaves: [{ izquierda: 'id', derecha: 'id' }] }],
      filtrosResultado: [{ campo: 'total', operador: 'between', valor: [9, 1] }],
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'filtrosResultado')).toBe(true);
  });
});

describe('ExportService CSV', () => {
  it('escapa comillas, comas y saltos de línea y neutraliza fórmulas', () => {
    expect(csvCell('hola, "mundo"')).toBe('"hola, ""mundo"""');
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('');
  });

  it('incluye BOM y todas las columnas aunque falten en la primera fila', () => {
    const text = new ExportService().exportToCsv([{ a: 1 }, { a: 2, b: 'x' }]).toString('utf8');
    expect(text.startsWith('﻿')).toBe(true);
    expect(csvLines(Buffer.from(text))).toEqual(['a,b', '1,', '2,x']);
  });
});
