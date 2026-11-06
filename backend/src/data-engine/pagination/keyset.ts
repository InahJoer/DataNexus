import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { getJsonByteLength, getMaxSourceBytes } from '../data-engine.constants.js';
import { createHash } from 'node:crypto';
import type { FilterNode } from '../filters/filter-tree.js';

/** Valor de la llave de la última fila de una página, tal como viaja dentro del cursor. */
export type CursorValue = string | number | boolean | { $oid: string } | { $date: string };

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 1000;
const MAX_CURSOR_LENGTH = 2048;
const CURSOR_VERSION = 1;

export interface DataPageOptions {
  schema?: string;
  /** Filtros que el adaptador ejecuta en el motor (ya validados). */
  filters?: FilterNode[];
  pageSize: number;
  /** Llave de la última fila de la página anterior; sin ella se lee la primera página. */
  after?: CursorValue[];
}

export interface DataPage {
  rows: Record<string, any>[];
  /** Columnas por las que se ordena y avanza la paginación (llave primaria, `_id` o id del documento). */
  orderBy: string[];
  /** Llave de la última fila leída; null si no hay más páginas. */
  lastKey: CursorValue[] | null;
}

/** Convierte el valor de una llave leído del driver al formato del cursor. */
export function toCursorValue(value: unknown): CursorValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return { $date: value.toISOString() };
  const bson = value as { _bsontype?: string; toHexString?: () => string } | null;
  if (bson && (bson._bsontype === 'ObjectId' || bson._bsontype === 'ObjectID') && typeof bson.toHexString === 'function') {
    return { $oid: bson.toHexString() };
  }
  throw new BadRequestException('La llave de esta tabla o colección tiene un tipo que no admite paginación con cursor');
}

/** Valor del cursor como parámetro SQL: fechas como Date; ObjectId no existe en SQL. */
export function toSqlParameter(value: CursorValue): string | number | boolean | Date {
  if (typeof value !== 'object') return value;
  if ('$date' in value) return new Date(value.$date);
  throw new BadRequestException('El cursor no es válido para esta fuente');
}

/**
 * Condición keyset para avanzar después de la última fila: `(a > ?) OR (a = ? AND b > ?) ...`.
 * Es equivalente a `(a, b) > (?, ?)` pero funciona en PostgreSQL, MySQL y SQL Server, y usa el índice de la llave
 * primaria, así que leer la página 20.000 cuesta lo mismo que leer la primera (sin OFFSET).
 */
export function buildKeysetCondition(
  quotedColumns: readonly string[],
  values: readonly CursorValue[],
  parameter: (value: string | number | boolean | Date) => string,
): string {
  if (values.length !== quotedColumns.length) throw new BadRequestException('El cursor no es válido para esta fuente');
  const sqlValues = values.map(toSqlParameter);
  // Un parámetro por aparición: en MySQL cada `?` consume un valor, así que no se pueden reutilizar.
  const branches = quotedColumns.map((column, index) => {
    const equalities = quotedColumns.slice(0, index).map((previous, j) => `${previous} = ${parameter(sqlValues[j])}`);
    return `(${[...equalities, `${column} > ${parameter(sqlValues[index])}`].join(' AND ')})`;
  });
  return branches.length === 1 ? branches[0] : `(${branches.join(' OR ')})`;
}

/** Huella que ata un cursor a su conexión, esquema y entidad: no se puede reutilizar en otra tabla. */
export function cursorBinding(connectionId: string, entity: string, schema?: string): string {
  return createHash('sha256').update(`${connectionId}\0${schema ?? ''}\0${entity}`, 'utf8').digest('base64url').slice(0, 16);
}

/** Cursor opaco (base64url) con la llave de la última fila y la huella de la entidad. */
export function encodeCursor(binding: string, key: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, b: binding, k: key }), 'utf8').toString('base64url');
}

const isCursorValue = (value: unknown): value is CursorValue => {
  if (typeof value === 'string') return value.length <= 1024;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const record = value as Record<string, unknown>;
  if (keys[0] === '$oid') return typeof record.$oid === 'string' && /^[0-9a-f]{24}$/i.test(record.$oid);
  if (keys[0] === '$date') return typeof record.$date === 'string' && !Number.isNaN(Date.parse(record.$date));
  return false;
};

/** Lee y valida un cursor: formato, versión, huella de la entidad y tipos de cada valor. */
export function decodeCursor(cursor: string, binding: string): CursorValue[] {
  const invalid = () => new BadRequestException('El cursor no es válido para esta tabla o colección. Vuelva a la primera página.');
  if (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const token = parsed as { v?: unknown; b?: unknown; k?: unknown };
  if (
    !token ||
    token.v !== CURSOR_VERSION ||
    token.b !== binding ||
    !Array.isArray(token.k) ||
    token.k.length === 0 ||
    token.k.length > 8 ||
    !token.k.every(isCursorValue)
  ) {
    throw invalid();
  }
  return token.k;
}

export const NO_PRIMARY_KEY_MESSAGE =
  'La tabla no tiene llave primaria: la exploración paginada necesita una llave única para avanzar sin saltarse filas. ' +
  'Use un cross-join o agregue una llave primaria a la tabla.';

/**
 * Arma la página a partir de las filas leídas (pageSize + 1 para saber si hay más): calcula la llave de la última
 * fila con los valores originales del driver, normaliza las filas y comprueba el límite de bytes por fuente.
 */
export function toDataPage(
  raw: Record<string, unknown>[],
  keys: string[],
  pageSize: number,
  normalize: (row: Record<string, unknown>) => Record<string, any>,
): DataPage {
  const hasMore = raw.length > pageSize;
  const pageRows = hasMore ? raw.slice(0, pageSize) : raw;
  const last = pageRows.at(-1);
  const lastKey = hasMore && last ? keys.map((key) => toCursorValue(last[key])) : null;
  const rows = pageRows.map(normalize);
  const maxBytes = getMaxSourceBytes();
  if (getJsonByteLength(rows) > maxBytes) {
    throw new PayloadTooLargeException(`La página supera el máximo de ${maxBytes} bytes configurado; pida menos filas`);
  }
  return { rows, orderBy: keys, lastKey };
}
