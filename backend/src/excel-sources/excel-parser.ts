import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';

/** Tamaño máximo del archivo subido (10 MB). */
export const EXCEL_MAX_BYTES = 10 * 1024 * 1024;
/** Registros máximos por libro (suma de todas las hojas). */
export const EXCEL_MAX_ROWS = 50_000;
export const EXCEL_MAX_COLUMNS = 200;
export const EXCEL_MAX_SHEETS = 20;
const MAX_NAME_LENGTH = 120;

export type ExcelCell = string | number | boolean | null;
export type ExcelRow = Record<string, ExcelCell>;

export interface ParsedSheet {
  nombre: string;
  /** Nombres de columna (fila 1) en el orden del archivo. */
  columnas: string[];
  /** Primera columna: el identificador de cada registro. */
  columnaId: string;
  filas: ExcelRow[];
  /** Observaciones sobre la columna identificadora (vacíos, repetidos) y ajustes de encabezados. */
  avisos: string[];
}

export type ExcelFormat = 'xlsx' | 'csv';

/** Formato por extensión y firma: .xlsx es un ZIP (PK), .csv/.txt es texto. El .xls binario antiguo no se admite. */
export function detectFormat(fileName: string, buffer: Buffer): ExcelFormat {
  const name = fileName.toLowerCase();
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (/\.(xlsx|xlsm)$/.test(name)) {
    if (!isZip) throw new BadRequestException('El archivo .xlsx está dañado o no es un libro de Excel');
    return 'xlsx';
  }
  if (/\.(csv|txt)$/.test(name)) return 'csv';
  if (name.endsWith('.xls')) {
    throw new BadRequestException('El formato .xls (Excel 97-2003) no se admite: guárdalo como .xlsx y vuelve a subirlo');
  }
  throw new BadRequestException('Sube un archivo .xlsx o .csv');
}

/** Lee el libro: cada hoja con datos produce una tabla cuya fila 1 son los encabezados y la columna 1 el identificador. */
export async function parseWorkbook(buffer: Buffer, fileName: string): Promise<ParsedSheet[]> {
  const format = detectFormat(fileName, buffer);
  const raw = format === 'csv' ? [{ nombre: baseName(fileName), rows: parseCsv(buffer) }] : await readXlsx(buffer);
  const sheets: ParsedSheet[] = [];
  const usedNames = new Set<string>();
  let total = 0;
  for (const sheet of raw) {
    const parsed = toSheet(uniqueName(sheet.nombre, usedNames), sheet.rows);
    if (!parsed) continue;
    total += parsed.filas.length;
    if (total > EXCEL_MAX_ROWS) {
      throw new BadRequestException(`El archivo supera el máximo de ${EXCEL_MAX_ROWS.toLocaleString('es')} registros`);
    }
    sheets.push(parsed);
  }
  if (!sheets.length) throw new BadRequestException('El archivo no tiene hojas con datos: la fila 1 debe tener los encabezados');
  if (sheets.length > EXCEL_MAX_SHEETS) throw new BadRequestException(`El libro tiene más de ${EXCEL_MAX_SHEETS} hojas con datos`);
  return sheets;
}

/** Valor de una celda de ExcelJS como valor JSON: fórmulas → resultado, texto enriquecido → texto, fechas → ISO. */
export function normalizeCell(value: unknown): ExcelCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? null : text;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString();
    // Excel guarda las fechas sin hora como medianoche UTC: se muestran como AAAA-MM-DD.
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'object') {
    const cell = value as { result?: unknown; richText?: { text: string }[]; text?: unknown; error?: unknown; formula?: unknown; sharedFormula?: unknown };
    if (cell.error !== undefined) return null;
    if ('formula' in cell || 'sharedFormula' in cell || 'result' in cell) return normalizeCell(cell.result);
    if (Array.isArray(cell.richText)) return normalizeCell(cell.richText.map((part) => part.text).join(''));
    if (cell.text !== undefined) return normalizeCell(typeof cell.text === 'object' ? normalizeCell(cell.text) : cell.text);
  }
  return null;
}

async function readXlsx(buffer: Buffer): Promise<{ nombre: string; rows: ExcelCell[][] }[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException('No se pudo leer el libro de Excel: verifica que el archivo no esté dañado ni protegido con contraseña');
  }
  const sheets: { nombre: string; rows: ExcelCell[][] }[] = [];
  workbook.eachSheet((worksheet) => {
    if (worksheet.state !== 'visible') return;
    const rows: ExcelCell[][] = [];
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = (row.values as unknown[]).slice(1).map(normalizeCell);
      rows[rowNumber - 1] = values;
    });
    sheets.push({ nombre: worksheet.name, rows: Array.from(rows, (row) => row ?? []) });
  });
  return sheets;
}

/** CSV RFC 4180 con detección del separador (coma, punto y coma o tabulador) y BOM opcional. */
export function parseCsv(buffer: Buffer): ExcelCell[][] {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? undefined : text.search(/\r?\n/));
  const delimiter = [',', ';', '\t'].map((candidate) => ({ candidate, count: countOutsideQuotes(firstLine, candidate) })).sort((a, b) => b.count - a.count)[0].candidate;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((cells) => cells.map(csvValue));
}

/** Texto del CSV como valor: números sin ceros a la izquierda se convierten; "007" sigue siendo texto (códigos). */
function csvValue(raw: string): ExcelCell {
  const text = raw.trim();
  if (text === '') return null;
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function countOutsideQuotes(line: string, char: string): number {
  let count = 0;
  let quoted = false;
  for (const current of line) {
    if (current === '"') quoted = !quoted;
    else if (!quoted && current === char) count += 1;
  }
  return count;
}

function toSheet(nombre: string, rows: ExcelCell[][]): ParsedSheet | null {
  const isEmpty = (row: ExcelCell[] | undefined) => !row || row.every((value) => value === null);
  const headerIndex = rows.findIndex((row) => !isEmpty(row));
  if (headerIndex === -1) return null;
  const header = rows[headerIndex];
  const firstColumn = header.findIndex((value) => value !== null);
  const lastColumn = Math.max(header.length, ...rows.slice(headerIndex + 1).map((row) => row?.length ?? 0)) - 1;
  if (lastColumn - firstColumn + 1 > EXCEL_MAX_COLUMNS) {
    throw new BadRequestException(`La hoja "${nombre}" tiene más de ${EXCEL_MAX_COLUMNS} columnas`);
  }

  const avisos: string[] = [];
  const columnas: string[] = [];
  for (let index = firstColumn; index <= lastColumn; index += 1) {
    const raw = header[index];
    let name = raw === null || raw === undefined ? '' : String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    if (!name) {
      name = `columna_${index - firstColumn + 1}`;
      avisos.push(`La columna ${index - firstColumn + 1} no tenía encabezado: se llamó "${name}"`);
    }
    let unique = name;
    for (let n = 2; columnas.includes(unique); n += 1) unique = `${name}_${n}`;
    if (unique !== name) avisos.push(`El encabezado "${name}" estaba repetido: la copia se llamó "${unique}"`);
    columnas.push(unique);
  }

  const filas: ExcelRow[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    if (isEmpty(row)) continue;
    const record: ExcelRow = {};
    columnas.forEach((column, offset) => { record[column] = row[firstColumn + offset] ?? null; });
    if (Object.values(record).every((value) => value === null)) continue;
    filas.push(record);
  }

  const columnaId = columnas[0];
  const ids = filas.map((row) => row[columnaId]);
  const empty = ids.filter((value) => value === null).length;
  const seen = new Set<string>();
  let repeated = 0;
  for (const value of ids) {
    if (value === null) continue;
    const key = String(value);
    if (seen.has(key)) repeated += 1;
    seen.add(key);
  }
  if (empty) avisos.push(`${empty} registro(s) no tienen valor en la columna identificadora "${columnaId}"`);
  if (repeated) avisos.push(`${repeated} identificador(es) de "${columnaId}" están repetidos`);
  return { nombre, columnas, columnaId, filas, avisos };
}

function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Hoja1';
}

function uniqueName(raw: string, used: Set<string>): string {
  // Sin caracteres de control (no imprimibles) en el nombre de la hoja.
  const base = raw.replace(/\p{Cc}/gu, '').trim().slice(0, MAX_NAME_LENGTH) || 'Hoja';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
  used.add(name.toLowerCase());
  return name;
}
