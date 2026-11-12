import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { ExcelAdapter } from '../data-engine/adapters/excel.adapter.js';
import type { DataSourceConnection } from '../data-engine/adapters/data-source-adapter.interface.js';
import { detectFormat, normalizeCell, parseCsv, parseWorkbook } from './excel-parser.js';
import type { ExcelSheetData, ExcelSheetStore } from './excel-sheet-store.js';

async function workbook(build: (book: ExcelJS.Workbook) => void): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  build(book);
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe('parseWorkbook', () => {
  it('usa la fila 1 como encabezados y la columna 1 como identificador, en cada hoja', async () => {
    const buffer = await workbook((book) => {
      const metas = book.addWorksheet('Metas');
      metas.addRow(['codigo', 'cliente', 'meta', 'fecha']);
      metas.addRow([1, 'Ana', 150.5, new Date(Date.UTC(2026, 0, 15))]);
      metas.addRow([2, { richText: [{ text: 'Lu' }, { text: 'is' }] }, { formula: 'B1*2', result: 300 }, null]);
      metas.addRow([]);
      metas.addRow([3, '  Eva  ', null, null]);
      const notas = book.addWorksheet('Notas');
      notas.addRow(['id', 'texto']);
      notas.addRow(['A-1', 'hola']);
      book.addWorksheet('Vacía');
    });
    const sheets = await parseWorkbook(buffer, 'metas.xlsx');
    expect(sheets.map((sheet) => sheet.nombre)).toEqual(['Metas', 'Notas']);
    const [metas] = sheets;
    expect(metas.columnas).toEqual(['codigo', 'cliente', 'meta', 'fecha']);
    expect(metas.columnaId).toBe('codigo');
    expect(metas.filas).toEqual([
      { codigo: 1, cliente: 'Ana', meta: 150.5, fecha: '2026-01-15' },
      { codigo: 2, cliente: 'Luis', meta: 300, fecha: null },
      { codigo: 3, cliente: 'Eva', meta: null, fecha: null },
    ]);
    expect(metas.avisos).toEqual([]);
  });

  it('nombra encabezados vacíos, separa repetidos y avisa de identificadores vacíos o duplicados', async () => {
    const buffer = await workbook((book) => {
      const sheet = book.addWorksheet('Datos');
      sheet.addRow(['id', 'valor', null, 'valor']);
      sheet.addRow([1, 'a', 'x', 'b']);
      sheet.addRow([1, 'c', 'y', 'd']);
      sheet.addRow([null, 'e', 'z', 'f']);
    });
    const [sheet] = await parseWorkbook(buffer, 'datos.xlsx');
    expect(sheet.columnas).toEqual(['id', 'valor', 'columna_3', 'valor_2']);
    expect(sheet.avisos).toEqual([
      'La columna 3 no tenía encabezado: se llamó "columna_3"',
      'El encabezado "valor" estaba repetido: la copia se llamó "valor_2"',
      '1 registro(s) no tienen valor en la columna identificadora "id"',
      '1 identificador(es) de "id" están repetidos',
    ]);
  });

  it('lee CSV con punto y coma, comillas y BOM; conserva códigos con ceros a la izquierda', async () => {
    const csv = Buffer.from('﻿codigo;nombre;monto\r\n007;"Pérez; Juan";12.5\r\n8;"Dice ""hola""";\r\n', 'utf8');
    const [sheet] = await parseWorkbook(csv, 'ventas 2026.csv');
    expect(sheet.nombre).toBe('ventas 2026');
    expect(sheet.filas).toEqual([
      { codigo: '007', nombre: 'Pérez; Juan', monto: 12.5 },
      { codigo: 8, nombre: 'Dice "hola"', monto: null },
    ]);
    expect(parseCsv(Buffer.from('a,b\n1,2'))).toEqual([['a', 'b'], [1, 2]]);
  });

  it('rechaza formatos no admitidos y archivos sin datos', async () => {
    expect(() => detectFormat('viejo.xls', Buffer.from('x'))).toThrow(/xls/);
    expect(() => detectFormat('foto.png', Buffer.from('x'))).toThrow(/xlsx o .csv/);
    expect(() => detectFormat('falso.xlsx', Buffer.from('hola'))).toThrow(/dañado/);
    await expect(parseWorkbook(Buffer.from('\r\n\r\n'), 'vacio.csv')).rejects.toThrow(/no tiene hojas con datos/);
  });

  it('normaliza celdas especiales', () => {
    expect(normalizeCell({ error: '#DIV/0!' })).toBeNull();
    expect(normalizeCell({ text: 'sitio', hyperlink: 'https://x' })).toBe('sitio');
    expect(normalizeCell(new Date('2026-03-01T10:30:00.000Z'))).toBe('2026-03-01T10:30:00.000Z');
    expect(normalizeCell(Number.NaN)).toBeNull();
  });
});

describe('ExcelAdapter', () => {
  const data: ExcelSheetData = {
    nombre: 'Metas',
    columnas: ['codigo', 'zona', 'meta'],
    columnaId: 'codigo',
    filas: [
      { codigo: 1, zona: 'Norte', meta: 10 },
      { codigo: 2, zona: 'Sur', meta: 20 },
      { codigo: 3, zona: 'Norte', meta: 30 },
      { codigo: 4, zona: 'Norte', meta: 40 },
    ],
  };
  const store = {
    sheetNames: async () => ['Metas'],
    columns: async () => data.columnas,
    sheet: async () => data,
  } as unknown as ExcelSheetStore;
  const adapter = new ExcelAdapter(store);
  const connection: DataSourceConnection = { id: 'x', tipoMotor: 'EXCEL', dbName: 'Metas', connectionString: '' };

  it('expone las hojas como tablas y sus columnas', async () => {
    expect(await adapter.listObjects(connection)).toEqual([{ name: 'Metas', type: 'TABLE' }]);
    expect(await adapter.listFields(connection, 'Metas')).toEqual(['codigo', 'zona', 'meta']);
  });

  it('pagina por posición aplicando los filtros', async () => {
    const filters = [{ campo: 'zona', operador: 'eq' as const, valor: 'Norte' }];
    const first = await adapter.readPage(connection, 'Metas', { pageSize: 2, filters });
    expect(first.rows.map((row) => row.codigo)).toEqual([1, 3]);
    expect(first.orderBy).toEqual(['codigo']);
    expect(first.lastKey).toEqual([2]);
    const second = await adapter.readPage(connection, 'Metas', { pageSize: 2, filters, after: first.lastKey! });
    expect(second.rows.map((row) => row.codigo)).toEqual([4]);
    expect(second.lastKey).toBeNull();
  });

  it('extrae con filtros y copias de las filas (el motor no altera la caché)', async () => {
    const rows = await adapter.extract(connection, 'Metas', { filters: [{ campo: 'meta', operador: 'gte', valor: 30 }] });
    expect(rows.map((row) => row.codigo)).toEqual([3, 4]);
    rows[0].meta = 999;
    expect(data.filas[2].meta).toBe(30);
  });
});
