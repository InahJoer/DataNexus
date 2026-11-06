import { BadRequestException, ConflictException } from '@nestjs/common';
import type { JsonScalar } from './data-source-adapter.interface.js';

export function assertExactPrimaryKey(
  input: Record<string, JsonScalar> | string,
  primaryKeyColumns: readonly string[],
): Record<string, JsonScalar> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('La llave primaria debe incluir todas las columnas SQL');
  }

  const supplied = Object.keys(input);
  if (
    supplied.length !== primaryKeyColumns.length ||
    supplied.some((column) => !primaryKeyColumns.includes(column)) ||
    supplied.some((column) => input[column] === null || !isJsonScalar(input[column]))
  ) {
    throw new BadRequestException('La llave primaria no coincide con las columnas de la tabla');
  }
  return input;
}

export function normalizeCellValue(value: unknown): JsonScalar {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new BadRequestException('El campo no contiene un valor editable');
    return value.toISOString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (isJsonScalar(value)) return value;

  if (value && typeof value === 'object') {
    const normalized = value as { toDate?: () => Date; toBase64?: () => string; path?: string; get?: () => unknown };
    if (typeof normalized.toDate === 'function') return normalizeCellValue(normalized.toDate());
    if (typeof normalized.toBase64 === 'function') return normalized.toBase64();
    if (typeof normalized.path === 'string' && typeof normalized.get === 'function') return normalized.path;
  }

  throw new BadRequestException('Solo se pueden editar celdas con valores escalares');
}

export function assertExpectedCellValue(actual: unknown, expected: JsonScalar): JsonScalar {
  let normalized: JsonScalar;
  try {
    normalized = normalizeCellValue(actual);
  } catch (error) {
    if (error instanceof BadRequestException) throw new ConflictException('El valor de la celda cambió desde la última lectura');
    throw error;
  }
  if (!Object.is(normalized, expected)) {
    throw new ConflictException('El valor de la celda cambió desde la última lectura');
  }
  return normalized;
}

export function decodeBase64CellValue(value: JsonScalar): Buffer | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException('El valor binario debe enviarse como base64');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new BadRequestException('El valor binario debe enviarse como base64 válido');
  return decoded;
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}
