import { afterAll, describe, expect, it } from 'vitest';
import { ExcelAdapter } from '../data-engine/adapters/excel.adapter.js';
import type { DataSourceConnection } from '../data-engine/adapters/data-source-adapter.interface.js';
import type { ExcelSheetStore } from './excel-sheet-store.js';
import { ExcelTableStore, type StoredSheet } from './excel-table-store.js';

/** Hojas de Excel guardadas en tablas de PostgreSQL real (DATABASE_URL, en CI): carga, tipos, filtros, semi-join. */
describe.skipIf(!process.env.DATABASE_URL)('ExcelTableStore con PostgreSQL real', () => {
  const store = new ExcelTableStore();
  const archivoId = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const created: string[] = [];
  const ROWS = 200_000;

  afterAll(async () => {
    await store.drop(created);
    await store.onModuleDestroy();
  });

  async function load(columnas: string[], rows: Iterable<Array<string | number | boolean | null>>) {
    const tabla = store.newTableName(archivoId);
    created.push(tabla);
    const loader = await store.createLoader(tabla, columnas);
    for (const row of rows) await loader.add(row);
    const result = await loader.finish();
    return { sheet: { tabla, columnas, tipos: result.tipos } satisfies StoredSheet, result };
  }

  it(`carga ${ROWS.toLocaleString('es')} filas, deduce los tipos y avisa de identificadores vacíos o repetidos`, async () => {
    function* rows() {
      for (let i = 1; i <= ROWS; i += 1) yield [i <= 2 ? 1 : i === 3 ? null : i, `Cliente ${i}`, i % 7, i % 2 === 0, i % 5 === 0 ? 'x' : i];
    }
    const started = Date.now();
    const { sheet, result } = await load(['id', 'nombre', 'zona', 'activo', 'mixta'], rows());
    expect(result.totalFilas).toBe(ROWS);
    expect(result.tipos).toEqual(['numero', 'texto', 'numero', 'booleano', 'texto']);
    expect(result.avisos).toEqual([
      '1 registro(s) no tienen valor en la columna identificadora "id"',
      '1 identificador(es) de "id" están repetidos',
    ]);
    expect(Date.now() - started).toBeLessThan(60_000);

    const sheets = { sheetNames: async () => ['Datos'], columns: async () => sheet.columnas, sheet: async () => ({ ...sheet, columnaId: 'id' }) };
    const adapter = new ExcelAdapter(sheets as unknown as ExcelSheetStore, store);
    const connection: DataSourceConnection = { id: archivoId, tipoMotor: 'EXCEL', dbName: 'x', connectionString: '' };

    // Página filtrada en PostgreSQL y cursor por posición.
    const filters = [{ campo: 'zona', operador: 'eq' as const, valor: 3 }];
    const first = await adapter.readPage(connection, 'Datos', { pageSize: 2, filters });
    // Las columnas conservan su tipo; una columna con números y textos queda como texto.
    expect(first.rows).toEqual([
      { id: null, nombre: 'Cliente 3', zona: 3, activo: false, mixta: '3' },
      { id: 10, nombre: 'Cliente 10', zona: 3, activo: true, mixta: 'x' },
    ]);
    expect(first.orderBy).toEqual(['id']);
    const second = await adapter.readPage(connection, 'Datos', { pageSize: 2, filters, after: first.lastKey! });
    expect(second.rows.map((row) => row.nombre)).toEqual(['Cliente 17', 'Cliente 24']);

    // Una página en lo profundo cuesta lo mismo que la primera (keyset sobre _fila).
    const deep = await adapter.readPage(connection, 'Datos', { pageSize: 3, after: [ROWS - 2] });
    expect(deep.rows.map((row) => row.id)).toEqual([ROWS - 1, ROWS]);
    expect(deep.lastKey).toBeNull();

    // Semi-join: de 200.000 filas solo viajan las que tienen una llave de la otra fuente.
    const matched = await adapter.extract(connection, 'Datos', { keyIn: { field: 'id', values: ['1', '150000', '999999999'] } });
    expect(matched.map((row) => row.nombre)).toEqual(['Cliente 1', 'Cliente 2', 'Cliente 150000']);

    // Sin filtros, la hoja completa supera el máximo por fuente.
    await expect(adapter.extract(connection, 'Datos')).rejects.toThrow(/máximo por fuente/);
    // Un texto contra una columna numérica es un 400, no un error del servidor.
    await expect(adapter.extract(connection, 'Datos', { filters: [{ campo: 'zona', operador: 'eq', valor: 'abc' }] })).rejects.toThrow(/no coincide con el tipo/);
    // contains funciona también sobre columnas numéricas.
    const contains = await adapter.extract(connection, 'Datos', { filters: [{ campo: 'nombre', operador: 'contains', valor: 'cliente 19999' }] });
    expect(contains.map((row) => row.id)).toEqual([19999, 199990, 199991, 199992, 199993, 199994, 199995, 199996, 199997, 199998, 199999]);
  }, 120_000);

  it('ajusta el tipo si un valor posterior no encaja y tipa columnas que empezaron vacías', async () => {
    function* rows() {
      for (let i = 1; i <= 12_000; i += 1) yield [i, i === 11_000 ? 'A-1' : i, i > 7_000 ? i % 2 === 0 : null];
    }
    const { sheet, result } = await load(['id', 'codigo', 'tarde'], rows());
    expect(result.tipos).toEqual(['numero', 'texto', 'booleano']);
    const extracted = await store.extract(sheet, { keyIn: { field: 'id', values: ['10', '11000', '8000'] }, maxRows: 10 });
    expect(extracted).toEqual([
      { id: 10, codigo: '10', tarde: null },
      { id: 8000, codigo: '8000', tarde: true },
      { id: 11000, codigo: 'A-1', tarde: true },
    ]);
  });

  it('una hoja solo con encabezados queda vacía y en texto', async () => {
    const { result } = await load(['codigo', 'valor'], []);
    expect(result).toEqual({ totalFilas: 0, tipos: ['texto', 'texto'], avisos: [] });
    expect((await store.listTables(store.tablePrefix(archivoId))).length).toBeGreaterThanOrEqual(2);
  });
});
