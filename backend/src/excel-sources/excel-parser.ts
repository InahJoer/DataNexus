import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import unzipper from 'unzipper';

export const EXCEL_MAX_COLUMNS = 1000;
export const EXCEL_MAX_SHEETS = 50;
const MAX_NAME_LENGTH = 120;
/** Filas que se entregan juntas al cargador (menos viajes a la base de datos). */
const BATCH_ROWS = 2_000;

/** Tamaño máximo del archivo subido. Sin EXCEL_MAX_UPLOAD_MB (o con 0) no hay límite. */
export function getExcelMaxUploadBytes(): number {
  const mb = Number(process.env.EXCEL_MAX_UPLOAD_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : Number.POSITIVE_INFINITY;
}

/** Registros máximos por libro. Sin EXCEL_MAX_ROWS (o con 0) no hay límite. */
export function getExcelMaxRows(): number {
  const rows = Number(process.env.EXCEL_MAX_ROWS);
  return Number.isSafeInteger(rows) && rows > 0 ? rows : Number.POSITIVE_INFINITY;
}

export type ExcelCell = string | number | boolean | null;
export type ExcelRow = Record<string, ExcelCell>;
export type ExcelFormat = 'xlsx' | 'csv';

/** Una hoja del libro: sus filas llegan por lotes y deben consumirse antes de pasar a la siguiente hoja. */
export interface RawSheet {
  nombre: string;
  rows: AsyncIterable<ExcelCell[][]>;
}

/** Formato por extensión y firma: .xlsx es un ZIP (PK), .csv/.txt es texto. El .xls binario antiguo no se admite. */
export function detectFormat(fileName: string, head: Buffer): ExcelFormat {
  const name = fileName.toLowerCase();
  const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b;
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

/** Lee los primeros bytes del archivo para validar el formato antes de procesarlo. */
export async function detectFileFormat(filePath: string, fileName: string): Promise<ExcelFormat> {
  const handle = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    return detectFormat(fileName, head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Lee el libro por streaming, sin cargarlo entero en memoria: cada hoja visible se entrega con sus filas por lotes.
 * `onProgress` informa el avance de 0 a 1.
 */
export async function* readWorkbook(filePath: string, fileName: string, onProgress?: (fraction: number) => void): AsyncGenerator<RawSheet> {
  const format = await detectFileFormat(filePath, fileName);
  if (format === 'xlsx') {
    yield* readXlsx(filePath, onProgress);
    return;
  }
  const { size } = await stat(filePath);
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  let read = 0;
  if (onProgress) stream.on('data', (chunk) => onProgress(size ? (read += chunk.length) / size : 1));
  try {
    yield { nombre: baseName(fileName), rows: csvRows(stream) };
  } finally {
    stream.destroy();
  }
}

const UNREADABLE = 'No se pudo leer el libro de Excel: verifica que el archivo no esté dañado ni protegido con contraseña';

/** Lector de ExcelJS por partes (métodos internos de WorkbookReader de exceljs 4.x). */
interface ExcelJsPartsReader {
  model?: { sheets?: Array<{ name: string; rId: string; state?: string }> };
  workbookRels?: Array<{ Id: string; Target: string }>;
  sharedStrings?: unknown[];
  _parseRels(entry: NodeJS.ReadableStream): Promise<void>;
  _parseWorkbook(entry: NodeJS.ReadableStream): Promise<void>;
  _parseSharedStrings(entry: NodeJS.ReadableStream): AsyncIterable<unknown>;
  _parseStyles(entry: NodeJS.ReadableStream): Promise<void>;
  _parseWorksheet(entry: NodeJS.ReadableStream, sheetNo: string): Iterable<{ eventType: string; value: { name: string } & AsyncIterable<{ values: unknown }> }>;
}

/**
 * Un .xlsx es un ZIP. El lector secuencial de ExcelJS falla cuando las hojas aparecen antes que workbook.xml (lo
 * hacen ExcelJS, LibreOffice y otros generadores), así que se usa el índice del ZIP para abrir cada parte en el orden
 * correcto: relaciones, libro, textos compartidos, estilos (fechas) y luego cada hoja visible, todo por streaming.
 */
async function* readXlsx(filePath: string, onProgress?: (fraction: number) => void): AsyncGenerator<RawSheet> {
  let entries: Map<string, unzipper.File>;
  try {
    const directory = await unzipper.Open.file(filePath);
    entries = new Map(directory.files.map((file) => [file.path.replace(/^\/+/, ''), file]));
  } catch {
    throw new BadRequestException(UNREADABLE);
  }
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  const book = entries.get('xl/workbook.xml');
  if (!rels || !book) throw new BadRequestException(UNREADABLE);

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(null as unknown as string, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    entries: 'ignore',
  }) as unknown as ExcelJsPartsReader;
  const sheets: Array<{ entry: unzipper.File; sheetNo: string }> = [];
  try {
    await reader._parseRels(rels.stream());
    await reader._parseWorkbook(book.stream());
    const shared = entries.get('xl/sharedStrings.xml');
    if (shared) for await (const _event of reader._parseSharedStrings(shared.stream())) void _event;
    reader.sharedStrings ??= [];
    const styles = entries.get('xl/styles.xml');
    if (styles) await reader._parseStyles(styles.stream());
    for (const sheet of reader.model?.sheets ?? []) {
      if (sheet.state && sheet.state !== 'visible') continue;
      const target = reader.workbookRels?.find((rel) => rel.Id === sheet.rId)?.Target ?? '';
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      const entry = entries.get(path);
      const sheetNo = /sheet(\d+)\.xml$/.exec(path)?.[1];
      if (entry && sheetNo) sheets.push({ entry, sheetNo });
    }
  } catch {
    throw new BadRequestException(UNREADABLE);
  }

  // Avance por los bytes ya descomprimidos de las hojas.
  const total = sheets.reduce((sum, sheet) => sum + (sheet.entry.uncompressedSize || 0), 0);
  let done = 0;
  for (const { entry, sheetNo } of sheets) {
    const stream = entry.stream();
    if (onProgress) stream.on('data', (chunk: Buffer) => onProgress(total ? Math.min(1, (done += chunk.length) / total) : 1));
    try {
      for (const { value } of reader._parseWorksheet(stream, sheetNo)) yield { nombre: value.name, rows: xlsxRows(value) };
    } finally {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    }
  }
}

async function* xlsxRows(sheet: AsyncIterable<{ values: unknown }>): AsyncGenerator<ExcelCell[][]> {
  let batch: ExcelCell[][] = [];
  for await (const row of sheet) {
    const values = row.values as unknown[];
    const cells: ExcelCell[] = new Array(Math.max(0, values.length - 1));
    for (let index = 1; index < values.length; index += 1) cells[index - 1] = normalizeCell(values[index]);
    batch.push(cells);
    if (batch.length >= BATCH_ROWS) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

async function* csvRows(stream: AsyncIterable<Buffer | string>): AsyncGenerator<ExcelCell[][]> {
  const parser = new CsvParser();
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of stream) {
    const rows = parser.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    for (let start = 0; start < rows.length; start += BATCH_ROWS) yield rows.slice(start, start + BATCH_ROWS);
  }
  const rest = parser.end(decoder.decode());
  if (rest.length) yield rest;
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

/**
 * CSV RFC 4180 incremental: recibe el texto por partes y devuelve las filas completas. Detecta el separador (coma,
 * punto y coma o tabulador) en la primera línea y quita el BOM.
 */
export class CsvParser {
  private delimiter: string | null = null;
  private pending = '';
  private row: string[] = [];
  private field = '';
  private quoted = false;
  private started = false;

  push(text: string): ExcelCell[][] {
    let input = text;
    if (!this.started) {
      this.pending += input;
      const newline = this.pending.search(/\r?\n/);
      if (newline === -1 && this.pending.length < 64 * 1024) return [];
      this.started = true;
      input = this.pending.replace(/^﻿/, '');
      this.pending = '';
      const firstLine = newline === -1 ? input : input.slice(0, input.search(/\r?\n/));
      this.delimiter = detectDelimiter(firstLine);
    }
    return this.consume(input);
  }

  end(tail = ''): ExcelCell[][] {
    const rows = tail ? this.push(tail) : [];
    if (!this.started) {
      this.started = true;
      const input = this.pending.replace(/^﻿/, '');
      this.pending = '';
      this.delimiter = detectDelimiter(input.split(/\r?\n/)[0] ?? '');
      rows.push(...this.consume(input));
    }
    if (this.field !== '' || this.row.length) {
      this.row.push(this.field);
      rows.push(this.row.map(csvValue));
      this.row = [];
      this.field = '';
    }
    return rows;
  }

  private consume(text: string): ExcelCell[][] {
    const rows: ExcelCell[][] = [];
    const delimiter = this.delimiter ?? ',';
    let field = this.field;
    let row = this.row;
    let quoted = this.quoted;
    let i = 0;
    // El trozo anterior terminó en \r: si este empieza con \n, es el mismo salto de línea (\r\n).
    if (this.pendingCR && text[0] === '\n') i = 1;
    this.pendingCR = false;
    if (this.pendingQuote && text.length) {
      // El trozo anterior terminó en una comilla dentro de un campo entre comillas: "" es una comilla escapada.
      this.pendingQuote = false;
      if (text[0] === '"') { field += '"'; i = 1; }
      else quoted = false;
    }
    for (; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char !== '"') field += char;
        else if (i + 1 >= text.length) this.pendingQuote = true;
        else if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else if (char === '"' && field === '') quoted = true;
      else if (char === delimiter) { row.push(field); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && i + 1 >= text.length) this.pendingCR = true;
        else if (char === '\r' && text[i + 1] === '\n') i += 1;
        row.push(field);
        rows.push(row.map(csvValue));
        row = [];
        field = '';
      } else field += char;
    }
    this.field = field;
    this.row = row;
    this.quoted = quoted;
    return rows;
  }

  private pendingQuote = false;
  private pendingCR = false;
}

/** CSV completo en memoria (pruebas y archivos pequeños). */
export function parseCsv(buffer: Buffer): ExcelCell[][] {
  const parser = new CsvParser();
  return [...parser.push(buffer.toString('utf8')), ...parser.end()];
}

function detectDelimiter(firstLine: string): string {
  return [',', ';', '\t'].map((candidate) => ({ candidate, count: countOutsideQuotes(firstLine, candidate) })).sort((a, b) => b.count - a.count)[0].candidate;
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

/**
 * Arma una hoja fila por fila: la primera fila con datos son los encabezados (definen las columnas) y la primera
 * columna es el identificador. Las demás filas se alinean a esas columnas; las vacías se descartan.
 */
export class SheetAssembler {
  columnas: string[] = [];
  readonly avisos: string[] = [];
  private firstColumn = 0;
  private ignoredCells = 0;

  constructor(readonly nombre: string) {}

  get hasHeader(): boolean {
    return this.columnas.length > 0;
  }

  /** Devuelve la fila alineada a las columnas, o null si era el encabezado o estaba vacía. */
  push(raw: ExcelCell[]): ExcelCell[] | null {
    if (!raw.length || raw.every((value) => value === null || value === undefined)) return null;
    if (!this.hasHeader) {
      this.readHeader(raw);
      return null;
    }
    const width = this.columnas.length;
    const row: ExcelCell[] = new Array(width);
    let any = false;
    for (let offset = 0; offset < width; offset += 1) {
      const value = raw[this.firstColumn + offset] ?? null;
      row[offset] = value;
      if (value !== null) any = true;
    }
    for (let index = this.firstColumn + width; index < raw.length; index += 1) {
      if (raw[index] !== null && raw[index] !== undefined) this.ignoredCells += 1;
    }
    return any ? row : null;
  }

  /** Avisos finales (se llama al terminar la hoja). */
  finish(): string[] {
    if (this.ignoredCells) {
      this.avisos.push(`${this.ignoredCells.toLocaleString('es')} valor(es) a la derecha de la última columna con encabezado se ignoraron`);
    }
    return this.avisos;
  }

  private readHeader(header: ExcelCell[]): void {
    this.firstColumn = header.findIndex((value) => value !== null && value !== undefined);
    let lastColumn = header.length - 1;
    while (lastColumn > this.firstColumn && (header[lastColumn] === null || header[lastColumn] === undefined)) lastColumn -= 1;
    if (lastColumn - this.firstColumn + 1 > EXCEL_MAX_COLUMNS) {
      throw new BadRequestException(`La hoja "${this.nombre}" tiene más de ${EXCEL_MAX_COLUMNS} columnas`);
    }
    const columnas: string[] = [];
    const used = new Set<string>();
    for (let index = this.firstColumn; index <= lastColumn; index += 1) {
      const raw = header[index];
      let name = raw === null || raw === undefined ? '' : String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
      if (!name) {
        name = `columna_${index - this.firstColumn + 1}`;
        this.avisos.push(`La columna ${index - this.firstColumn + 1} no tenía encabezado: se llamó "${name}"`);
      }
      let unique = name;
      for (let n = 2; used.has(unique.toLowerCase()); n += 1) unique = `${name}_${n}`;
      if (unique !== name) this.avisos.push(`El encabezado "${name}" estaba repetido: la copia se llamó "${unique}"`);
      used.add(unique.toLowerCase());
      columnas.push(unique);
    }
    this.columnas = columnas;
  }
}

export function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Hoja1';
}

export function uniqueName(raw: string, used: Set<string>): string {
  // Sin caracteres de control (no imprimibles) en el nombre de la hoja.
  const base = raw.replace(/\p{Cc}/gu, '').trim().slice(0, MAX_NAME_LENGTH) || 'Hoja';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
  used.add(name.toLowerCase());
  return name;
}
