import { BadRequestException } from '@nestjs/common';
import { FILTER_OPERATORS, type DataFilter } from '../dto/cross-join.dto.js';
import { isScalarFilterValue } from './sql-filters.js';

const MAX_FIELD_LENGTH = 150;
const MAX_LIST_VALUES = 10;

const MONGO_OPERATORS = {
  eq: '$eq',
  neq: '$ne',
  gt: '$gt',
  gte: '$gte',
  lt: '$lt',
  lte: '$lte',
  in: '$in',
  'not-in': '$nin',
} as const;

/**
 * Valida el nombre de un campo de MongoDB. Se admiten rutas con punto (`cliente.id`), pero ningún segmento
 * puede estar vacío ni empezar por `$`: así un campo nunca se interpreta como operador (`$where`, `$expr`...).
 */
export function assertMongoFieldName(field: unknown): asserts field is string {
  if (
    typeof field !== 'string' ||
    !field.trim() ||
    field.length > MAX_FIELD_LENGTH ||
    field.includes('\0') ||
    field.split('.').some((segment) => !segment || segment.startsWith('$'))
  ) {
    throw new BadRequestException('El campo de filtro de MongoDB no es válido');
  }
}

/** Valida el nombre de una colección: sin `$`, sin NUL y sin colecciones internas `system.*`. */
export function assertMongoCollectionName(collection: unknown): asserts collection is string {
  if (
    typeof collection !== 'string' ||
    !collection.trim() ||
    collection.length > 120 ||
    collection.includes('$') ||
    collection.includes('\0') ||
    collection.startsWith('system.')
  ) {
    throw new BadRequestException('El nombre de la colección de MongoDB no es válido');
  }
}

/**
 * Traduce los filtros del cross-join a un filtro de MongoDB (filter pushdown). Los valores solo pueden ser
 * escalares, nunca objetos, por lo que no es posible inyectar operadores como `{ $gt: '' }` o `$where`.
 * Varias condiciones sobre el mismo campo se combinan con `$and`.
 */
export function buildMongoFilter(filters: readonly DataFilter[] = []): Record<string, unknown> {
  const supported = new Set<string>(FILTER_OPERATORS);
  const conditions: Record<string, unknown>[] = [];

  for (const filter of filters) {
    if (!filter || !supported.has(filter.operador)) {
      throw new BadRequestException('El operador de filtro no está soportado');
    }
    assertMongoFieldName(filter.campo);
    const operator = MONGO_OPERATORS[filter.operador];

    if (filter.operador === 'in' || filter.operador === 'not-in') {
      if (
        !Array.isArray(filter.valor) ||
        filter.valor.length === 0 ||
        filter.valor.length > MAX_LIST_VALUES ||
        filter.valor.some((value) => value === null || !isScalarFilterValue(value))
      ) {
        throw new BadRequestException('El valor del filtro de lista no es válido');
      }
      conditions.push({ [filter.campo]: { [operator]: [...filter.valor] } });
      continue;
    }

    const value = filter.valor;
    if (value === null) {
      if (filter.operador !== 'eq' && filter.operador !== 'neq') {
        throw new BadRequestException('El valor del filtro no es válido');
      }
      // En MongoDB `{ campo: null }` también encuentra documentos sin el campo, igual que IS NULL en SQL.
      conditions.push({ [filter.campo]: { [operator]: null } });
      continue;
    }
    if (!isScalarFilterValue(value)) throw new BadRequestException('El valor del filtro no es válido');
    conditions.push({ [filter.campo]: { [operator]: value } });
  }

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
}
