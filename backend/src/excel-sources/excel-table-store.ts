import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { buildSqlFilterClauses } from '../data-engine/adapters/sql-filters.js';
import type { FilterNode } from '../data-engine/filters/filter-tree.js';
import type { ExcelCell } from './excel-parser.js';

export type ExcelColumnType = 'texto' | 'numero' | 'booleano';

/** Hoja guardada: columnas lógicas (encabezados) y su tabla física con columnas c1..cN y la llave _fila. */
export interface StoredSheet {
  tabla: string;
  columnas: string[];
  tipos: ExcelColumnType[];
}

export interface LoadResult {
  totalFilas: number;
  tipos: ExcelColumnType[];
  avisos: string[];
}

/** Filas por INSERT: con unnest cada columna es un solo parámetro (un arreglo), así que el lote puede ser grande. */
const INSERT_BATCH = 5_000;
const TABLE_PREFIX = 'xl_';
const TABLE_PATTERN = /^xl_[0-9a-f]{12}_[0-9a-f]{16}$/;
/** Errores de PostgreSQL por un valor que no encaja con el tipo de la columna (p. ej. filtrar "abc" en números). */
const INVALID_VALUE_CODES = new Set(['22P02', '22003', '22007', '22008']);

const physical = (index: number) => `"c${index + 1}"`;
const SQL_TYPE = { numero: 'double precision', booleano: 'boolean', texto: 'text' } as const;

/**
 * Almacenamiento de las hojas de Excel en tablas propias de la base de datos de la aplicación (mismo esquema que
 * Prisma). Así una hoja de millones de filas se filtra, ordena y pagina en PostgreSQL con índices, en lugar de
 * cargarla entera en memoria. Los nombres de tabla y columna son generados (nunca vienen del archivo) y los valores
 * siempre van como parámetros.
 */
@Injectable()
export class ExcelTableStore implements OnModuleDestroy {
  private readonly logger = new Logger(ExcelTableStore.name);
  private pool: Pool | null = null;
  readonly schema: string;
  private readonly connectionString: string;

  constructor() {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/datanexus');
    this.schema = url.searchParams.get('schema') || 'public';
    // Parámetros propios de Prisma que el driver pg no entiende.
    for (const key of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'socket_timeout', 'statement_cache_size']) {
      url.searchParams.delete(key);
    }
    this.connectionString = url.toString();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
    this.pool = null;
  }

  /** Nombre de tabla nuevo para una hoja del archivo (el prefijo permite limpiar cargas interrumpidas). */
  newTableName(archivoId: string): string {
    return `${TABLE_PREFIX}${archivoId.replace(/-/g, '').slice(0, 12).toLowerCase()}_${randomBytes(8).toString('hex')}`;
  }

  tablePrefix(archivoId: string): string {
    return `${TABLE_PREFIX}${archivoId.replace(/-/g, '').slice(0, 12).toLowerCase()}_`;
  }

  /** Crea la tabla y devuelve un cargador que inserta por lotes. */
  async createLoader(tabla: string, columnas: string[]): Promise<TableLoader> {
    const table = this.qualified(tabla);
    const definition = columnas.map((_, index) => `${physical(index)} text`).join(', ');
    await this.getPool().query(`CREATE TABLE ${table} ("_fila" bigint NOT NULL${definition ? `, ${definition}` : ''})`);
    return new TableLoader(this.getPool(), table, columnas);
  }

  async drop(tablas: string[]): Promise<void> {
    for (const tabla of tablas) {
      if (!TABLE_PATTERN.test(tabla)) continue;
      await this.getPool().query(`DROP TABLE IF EXISTS ${this.qualified(tabla)}`).catch((error: Error) => {
        this.logger.warn(`No se pudo eliminar la tabla de Excel ${tabla}: ${error.message}`);
      });
    }
  }

  /** Tablas de Excel existentes con un prefijo (para limpiar cargas que no terminaron). */
  async listTables(prefix: string): Promise<string[]> {
    const result = await this.getPool().query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1 AND left(table_name, $2) = $3`,
      [this.schema, prefix.length, prefix],
    );
    return result.rows.map((row) => row.name).filter((name) => TABLE_PATTERN.test(name));
  }

  /**
   * Página de registros en el orden del archivo (keyset sobre _fila: cualquier página cuesta lo mismo).
   * Devuelve la última _fila leída como cursor.
   */
  async readPage(sheet: StoredSheet, filters: FilterNode[] | undefined, after: number | null, pageSize: number) {
    const { where, values } = this.where(sheet, filters);
    if (after !== null) {
      values.push(after);
      where.push(`"_fila" > $${values.length}`);
    }
    const rows = await this.run<Record<string, unknown>>(
      `SELECT "_fila", ${this.projection(sheet)} FROM ${this.qualified(sheet.tabla)}` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY "_fila" LIMIT ${pageSize + 1}`,
      values,
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      rows: page.map((row) => this.toRecord(sheet, row)),
      lastKey: hasMore && last ? Number(last._fila) : null,
    };
  }

  /**
   * Registros para cruces y exportaciones, con los filtros ejecutados en PostgreSQL. `keyIn` limita la hoja a los
   * valores de llave que existen en la otra fuente del cruce (semi-join): de un millón de filas solo viajan las que
   * pueden coincidir. Lee hasta `maxRows + 1` para que quien llama detecte que se superó el máximo.
   */
  async extract(
    sheet: StoredSheet,
    options: { filters?: FilterNode[]; keyIn?: { field: string; values: string[] }; maxRows: number },
  ): Promise<Record<string, unknown>[]> {
    const { where, values } = this.where(sheet, options.filters);
    if (options.keyIn) {
      const index = sheet.columnas.indexOf(options.keyIn.field);
      if (index === -1) throw new BadRequestException('El campo de la llave no existe en la hoja');
      const tipo = sheet.tipos[index] ?? 'texto';
      if (tipo === 'numero') {
        // Llaves numéricas: comparación directa con el índice de la columna (las que no son números no pueden coincidir).
        values.push(options.keyIn.values.map(Number).filter(Number.isFinite));
        where.push(`${physical(index)} = ANY($${values.length}::double precision[])`);
      } else {
        values.push(options.keyIn.values);
        where.push(`${keyExpression(index, tipo)} = ANY($${values.length}::text[])`);
      }
    }
    const rows = await this.run<Record<string, unknown>>(
      `SELECT ${this.projection(sheet)} FROM ${this.qualified(sheet.tabla)}` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY "_fila" LIMIT ${options.maxRows + 1}`,
      values,
    );
    return rows.map((row) => this.toRecord(sheet, row));
  }

  private where(sheet: StoredSheet, filters: FilterNode[] | undefined) {
    const values: unknown[] = [];
    const where = buildSqlFilterClauses(sheet.columnas, filters ?? [], {
      column: (name) => physical(sheet.columnas.indexOf(name)),
      text: (column) => `CAST(${column} AS text)`,
      parameter: (value) => {
        values.push(value);
        return `$${values.length}`;
      },
    });
    return { where, values };
  }

  private projection(sheet: StoredSheet): string {
    return sheet.columnas.map((_, index) => physical(index)).join(', ');
  }

  private toRecord(sheet: StoredSheet, row: Record<string, unknown>): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    sheet.columnas.forEach((column, index) => {
      record[column] = row[`c${index + 1}`] ?? null;
    });
    return record;
  }

  private async run<T extends Record<string, unknown>>(text: string, values: unknown[]): Promise<T[]> {
    try {
      return (await this.getPool().query<T>(text, values)).rows;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code && INVALID_VALUE_CODES.has(code)) {
        throw new BadRequestException('El valor del filtro no coincide con el tipo de la columna (por ejemplo, texto en una columna numérica)');
      }
      if (code === '42P01') throw new BadRequestException('La hoja ya no existe: el archivo se reemplazó o eliminó');
      throw error;
    }
  }

  qualified(tabla: string): string {
    if (!TABLE_PATTERN.test(tabla)) throw new BadRequestException('Tabla de Excel no válida');
    return `"${this.schema.replace(/"/g, '""')}"."${tabla}"`;
  }

  private getPool(): Pool {
    this.pool ??= new Pool({ connectionString: this.connectionString, max: 6, idleTimeoutMillis: 30_000 });
    return this.pool;
  }
}

/**
 * Expresión de la llave de texto: recortada, igual que normalizeJoinKey en el motor de cruces. Con intercalación "C"
 * el índice se crea unas 12 veces más rápido en millones de filas y la igualdad es la misma.
 */
function keyExpression(index: number, tipo: ExcelColumnType | 'pendiente'): string {
  return tipo === 'texto' || tipo === 'pendiente' ? `(btrim(${physical(index)}) COLLATE "C")` : `(${physical(index)}::text)`;
}

/** Índice de la columna identificadora: directo si es numérica, sobre el texto recortado si es texto. */
function keyIndexExpression(tipo: ExcelColumnType): string {
  return tipo === 'numero' ? physical(0) : keyExpression(0, tipo);
}

/**
 * Inserta las filas de una hoja por lotes con `INSERT ... SELECT * FROM unnest(...)` (un arreglo por columna), lleva
 * la cuenta de los tipos de cada columna y, al terminar, convierte las columnas numéricas o booleanas, crea la llave
 * _fila, el índice de la columna identificadora y las estadísticas.
 */
export class TableLoader {
  private buffer: ExcelCell[][] = [];
  private total = 0;
  /** Tipo físico actual de cada columna; 'pendiente' = aún sin valores (se guarda como texto). */
  private readonly types: Array<ExcelColumnType | 'pendiente'>;
  /** Lo visto en las columnas pendientes, para decidir su tipo al final. */
  private readonly seen: Array<{ number: boolean; boolean: boolean; text: boolean }>;

  constructor(
    private readonly pool: Pool,
    private readonly table: string,
    private readonly columnas: string[],
  ) {
    this.types = columnas.map(() => 'pendiente');
    this.seen = columnas.map(() => ({ number: false, boolean: false, text: false }));
  }

  private inflight: Promise<void> = Promise.resolve();

  get rows(): number {
    return this.total + this.buffer.length;
  }

  async add(row: ExcelCell[]): Promise<void> {
    this.buffer.push(row);
    if (this.buffer.length >= INSERT_BATCH) await this.flush();
  }

  /**
   * Inserta el lote. El tipo de cada columna se decide con el primer lote que trae valores (la tabla aún está vacía,
   * así que cambiarlo es instantáneo) y los datos viajan ya tipados: no hace falta reescribir la tabla al final. Si
   * después aparece un texto en una columna numérica o booleana, esa columna pasa a texto.
   */
  async flush(): Promise<void> {
    if (!this.buffer.length) return;
    const batch = this.buffer;
    this.buffer = [];
    const width = this.columnas.length;

    const alters: string[] = [];
    for (let c = 0; c < width; c += 1) {
      const current = this.types[c];
      if (current === 'texto') continue;
      let number = false;
      let boolean = false;
      let text = false;
      for (const row of batch) {
        const value = row[c];
        if (value === null || value === undefined) continue;
        if (typeof value === 'number') number = true;
        else if (typeof value === 'boolean') boolean = true;
        else text = true;
      }
      const mixed = text || (number && boolean);
      if (current === 'pendiente') {
        if (this.total > 0) {
          // Ya hay filas guardadas como texto: se sigue en texto y se decide al final.
          const seen = this.seen[c];
          seen.number ||= number;
          seen.boolean ||= boolean;
          seen.text ||= text;
          continue;
        }
        if (!number && !boolean && !text) continue;
        const tipo: ExcelColumnType = mixed ? 'texto' : number ? 'numero' : 'booleano';
        this.types[c] = tipo;
        if (tipo !== 'texto') alters.push(`ALTER COLUMN ${physical(c)} TYPE ${SQL_TYPE[tipo]} USING ${physical(c)}::${SQL_TYPE[tipo]}`);
      } else if (mixed || (current === 'numero' && boolean) || (current === 'booleano' && number)) {
        this.types[c] = 'texto';
        alters.push(`ALTER COLUMN ${physical(c)} TYPE text USING ${physical(c)}::text`);
      }
    }
    if (alters.length) {
      await this.inflight;
      await this.pool.query(`ALTER TABLE ${this.table} ${alters.join(', ')}`);
    }

    const ids: number[] = new Array(batch.length);
    const columns: unknown[][] = Array.from({ length: width }, () => new Array<unknown>(batch.length));
    for (let r = 0; r < batch.length; r += 1) {
      ids[r] = this.total + r + 1;
      const row = batch[r];
      for (let c = 0; c < width; c += 1) {
        const value = row[c];
        if (value === null || value === undefined) columns[c][r] = null;
        else if (this.types[c] === 'numero' || this.types[c] === 'booleano') columns[c][r] = value;
        else columns[c][r] = typeof value === 'string' ? value : typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
      }
    }
    const params = ['$1::bigint[]', ...this.types.map((type, index) => `$${index + 2}::${type === 'pendiente' ? 'text' : SQL_TYPE[type]}[]`)];
    // Un INSERT en vuelo a la vez: mientras PostgreSQL guarda este lote, se lee y prepara el siguiente.
    await this.inflight;
    this.total += batch.length;
    const insert = this.pool.query(`INSERT INTO ${this.table} SELECT * FROM unnest(${params.join(', ')})`, [ids, ...columns]).then(() => undefined);
    // El error se recoge al esperar el siguiente lote o en finish(); esto solo evita un rechazo "sin manejar".
    insert.catch(() => undefined);
    this.inflight = insert;
  }

  /** Termina la carga: tipos, llave, índice y estadísticas. Devuelve los avisos sobre la columna identificadora. */
  async finish(): Promise<LoadResult> {
    await this.flush();
    await this.inflight;
    const client: PoolClient = await this.pool.connect();
    try {
      // Columnas que empezaron vacías y luego resultaron numéricas o booleanas (poco común): única reescritura.
      const late = this.types.flatMap((type, index) => {
        if (type !== 'pendiente') return [];
        const seen = this.seen[index];
        const tipo: ExcelColumnType = seen.text || (seen.number && seen.boolean) ? 'texto' : seen.number ? 'numero' : seen.boolean ? 'booleano' : 'texto';
        this.types[index] = tipo;
        return tipo === 'texto' ? [] : [`ALTER COLUMN ${physical(index)} TYPE ${SQL_TYPE[tipo]} USING ${physical(index)}::${SQL_TYPE[tipo]}`];
      });
      if (late.length) await client.query(`ALTER TABLE ${this.table} ${late.join(', ')}`);
      await client.query(`ALTER TABLE ${this.table} ADD PRIMARY KEY ("_fila")`);
      const avisos: string[] = [];
      if (this.columnas.length) {
        const keyIndex = keyIndexExpression(this.types[0] as ExcelColumnType);
        await client.query(`CREATE INDEX ON ${this.table} (${keyIndex})`);
        // Repetidos con agregación por hash (más rápida que COUNT DISTINCT en millones de filas).
        const stats = await client.query<{ vacios: string; repetidos: string }>(
          `SELECT (SELECT count(*) FROM ${this.table} WHERE ${physical(0)} IS NULL) AS vacios,
                  (SELECT COALESCE(sum(n - 1), 0) FROM (
                     SELECT count(*) AS n FROM ${this.table} WHERE ${physical(0)} IS NOT NULL
                     GROUP BY ${keyIndex} HAVING count(*) > 1) AS d) AS repetidos`,
        );
        const vacios = Number(stats.rows[0]?.vacios ?? 0);
        const repetidos = Number(stats.rows[0]?.repetidos ?? 0);
        const columnaId = this.columnas[0];
        if (vacios) avisos.push(`${vacios.toLocaleString('es')} registro(s) no tienen valor en la columna identificadora "${columnaId}"`);
        if (repetidos) avisos.push(`${repetidos.toLocaleString('es')} identificador(es) de "${columnaId}" están repetidos`);
      }
      await client.query(`ANALYZE ${this.table}`);
      return { totalFilas: this.total, tipos: this.types as ExcelColumnType[], avisos };
    } finally {
      client.release();
    }
  }
}
