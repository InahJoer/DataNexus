import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import { semiJoinKeys, type JoinPlan } from '../data-engine/join/join-plan.js';
import { CsvParser, SheetAssembler, detectFormat, normalizeCell, parseCsv, readWorkbook, uniqueName, type ExcelCell } from './excel-parser.js';

const dir = mkdtempSync(join(tmpdir(), 'dn-excel-spec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function workbookFile(name: string, build: (book: ExcelJS.Workbook) => void): Promise<string> {
  const book = new ExcelJS.Workbook();
  build(book);
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(await book.xlsx.writeBuffer()));
  return path;
}

/** Lee el archivo como lo hace la carga: streaming + SheetAssembler, juntando las filas en memoria. */
async function parse(path: string, fileName: string) {
  const used = new Set<string>();
  const sheets: Array<{ nombre: string; columnas: string[]; filas: ExcelCell[][]; avisos: string[] }> = [];
  let progress = 0;
  for await (const raw of readWorkbook(path, fileName, (fraction) => (progress = fraction))) {
    const assembler = new SheetAssembler(uniqueName(raw.nombre, used));
    const filas: ExcelCell[][] = [];
    for await (const batch of raw.rows) {
      for (const cells of batch) {
        const row = assembler.push(cells);
        if (row) filas.push(row);
      }
    }
    if (assembler.hasHeader) sheets.push({ nombre: assembler.nombre, columnas: assembler.columnas, filas, avisos: assembler.finish() });
  }
  return { sheets, progress };
}

describe('lectura por streaming de Excel y CSV', () => {
  it('usa la fila 1 como encabezados y la columna 1 como identificador, en cada hoja visible', async () => {
    const path = await workbookFile('metas.xlsx', (book) => {
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
      book.addWorksheet('Oculta', { state: 'hidden' }).addRow(['x', 'y']);
    });
    const { sheets, progress } = await parse(path, 'metas.xlsx');
    expect(progress).toBe(1);
    expect(sheets.map((sheet) => sheet.nombre)).toEqual(['Metas', 'Notas']);
    const [metas] = sheets;
    expect(metas.columnas).toEqual(['codigo', 'cliente', 'meta', 'fecha']);
    expect(metas.filas).toEqual([
      [1, 'Ana', 150.5, '2026-01-15'],
      [2, 'Luis', 300, null],
      [3, 'Eva', null, null],
    ]);
    expect(metas.avisos).toEqual([]);
  });

  it('nombra encabezados vacíos, separa repetidos y avisa de valores sin encabezado', async () => {
    const path = await workbookFile('datos.xlsx', (book) => {
      const sheet = book.addWorksheet('Datos');
      sheet.addRow(['id', 'valor', null, 'valor']);
      sheet.addRow([1, 'a', 'x', 'b']);
      sheet.addRow([2, 'c', 'y', 'd', 'sobra']);
    });
    const [sheet] = (await parse(path, 'datos.xlsx')).sheets;
    expect(sheet.columnas).toEqual(['id', 'valor', 'columna_3', 'valor_2']);
    expect(sheet.filas[1]).toEqual([2, 'c', 'y', 'd']);
    expect(sheet.avisos).toEqual([
      'La columna 3 no tenía encabezado: se llamó "columna_3"',
      'El encabezado "valor" estaba repetido: la copia se llamó "valor_2"',
      '1 valor(es) a la derecha de la última columna con encabezado se ignoraron',
    ]);
  });

  it('lee CSV con punto y coma, comillas y BOM; conserva códigos con ceros a la izquierda', async () => {
    const path = join(dir, 'ventas.csv');
    writeFileSync(path, Buffer.from('﻿codigo;nombre;monto\r\n007;"Pérez; Juan";12.5\r\n8;"Dice ""hola""";\r\n', 'utf8'));
    const [sheet] = (await parse(path, 'ventas 2026.csv')).sheets;
    expect(sheet.nombre).toBe('ventas 2026');
    expect(sheet.filas).toEqual([
      ['007', 'Pérez; Juan', 12.5],
      [8, 'Dice "hola"', null],
    ]);
    expect(parseCsv(Buffer.from('a,b\n1,2'))).toEqual([['a', 'b'], [1, 2]]);
  });

  it('el CSV incremental da el mismo resultado sin importar dónde se corten los trozos', () => {
    const text = 'id,nota\r\n1,"a ""b"" c"\r\n2,"línea\nnueva"\r\n3,fin';
    const expected = parseCsv(Buffer.from(text));
    for (let size = 1; size <= 7; size += 1) {
      const parser = new CsvParser();
      const rows: ExcelCell[][] = [];
      for (let start = 0; start < text.length; start += size) rows.push(...parser.push(text.slice(start, start + size)));
      rows.push(...parser.end());
      expect(rows, `trozos de ${size}`).toEqual(expected);
    }
    expect(expected).toEqual([['id', 'nota'], [1, 'a "b" c'], [2, 'línea\nnueva'], [3, 'fin']]);
  });

  it('rechaza formatos no admitidos', () => {
    expect(() => detectFormat('viejo.xls', Buffer.from('x'))).toThrow(/xls/);
    expect(() => detectFormat('foto.png', Buffer.from('x'))).toThrow(/xlsx o .csv/);
    expect(() => detectFormat('falso.xlsx', Buffer.from('hola'))).toThrow(/dañado/);
  });

  it('normaliza celdas especiales', () => {
    expect(normalizeCell({ error: '#DIV/0!' })).toBeNull();
    expect(normalizeCell({ text: 'sitio', hyperlink: 'https://x' })).toBe('sitio');
    expect(normalizeCell(new Date('2026-03-01T10:30:00.000Z'))).toBe('2026-03-01T10:30:00.000Z');
    expect(normalizeCell(Number.NaN)).toBeNull();
  });
});

describe('semi-join para hojas grandes', () => {
  const plan = (tipo: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'): JoinPlan => ({
    sources: [
      { alias: 'clientes', conexionId: 'pg', entidad: 'clientes' },
      { alias: 'metas', conexionId: 'xl', entidad: 'Metas' },
    ],
    relations: [{ izquierda: 'clientes', derecha: 'metas', tipo, llaves: [{ izquierda: 'id', derecha: 'id_cliente' }] }],
  });
  const extracted = new Map([['clientes', [{ id: 1 }, { id: ' 2 ' }, { id: 1 }, { id: null }]]]);

  it('reduce la hoja a las llaves de la otra fuente cuando un registro sin pareja se descarta', () => {
    expect(semiJoinKeys(plan('INNER'), 'metas', extracted)).toEqual({ field: 'id_cliente', values: ['1', '2'] });
    expect(semiJoinKeys(plan('LEFT'), 'metas', extracted)).toEqual({ field: 'id_cliente', values: ['1', '2'] });
  });

  it('no reduce cuando el join conserva los registros sin pareja de la hoja', () => {
    expect(semiJoinKeys(plan('RIGHT'), 'metas', extracted)).toBeNull();
    expect(semiJoinKeys(plan('FULL'), 'metas', extracted)).toBeNull();
    expect(semiJoinKeys(plan('INNER'), 'metas', new Map())).toBeNull();
  });
});

describe('ExcelSourcesService ante una base de datos sin espacio', () => {
  it('no tumba la API: registra el error aunque la base de datos ya no responda para marcar el fallo', async () => {
    const { ExcelSourcesService } = await import('./excel-sources.service.js');
    const path = join(dir, 'lleno.csv');
    writeFileSync(path, 'id,valor\n1,a\n2,b\n');
    const diskFull = Object.assign(new Error('could not write to file "pg_wal/xlogtemp.1": No space left on device'), { code: '53100' });
    const down = new Error('FATAL: the database system is in recovery mode');
    const prisma = {
      archivoExcel: {
        create: async () => ({ id: 'a1', nombre: 'x', nombreArchivo: 'lleno.csv', tamanoBytes: 10n, creadoPor: 'a@b.c', createdAt: new Date(), updatedAt: new Date(), estado: 'PROCESANDO', progreso: 0, filasProcesadas: 0, error: null, avisos: [], hojas: [] }),
        findUnique: async () => { throw down; },
      },
    };
    const tables = {
      assertStorage: async () => undefined,
      checkpoint: async () => undefined,
      newTableName: () => 'xl_000000000000_0000000000000000',
      createLoader: async () => { throw diskFull; },
      drop: async () => undefined,
    };
    const service = new ExcelSourcesService(prisma as never, {} as never, tables as never, {} as never);
    const errors: string[] = [];
    (service as unknown as { logger: { error: (m: string) => void; log: () => void } }).logger = { error: (m) => errors.push(m), log: () => undefined };
    const actor = { id: 'u', email: 'a@b.c', workspaceId: 'w', role: 'ADMIN' } as never;
    await service.upload(actor, { originalname: 'lleno.csv', mimetype: 'text/csv', size: 18, path }, undefined, {});
    await service.idle();
    expect(errors.join('\n')).toMatch(/No space left on device/);
    expect(errors.join('\n')).toMatch(/No se pudo marcar el Excel a1 como fallido/);
  }, 30_000);
});
