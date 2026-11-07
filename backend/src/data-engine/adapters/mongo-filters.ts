import { BadRequestException } from '@nestjs/common';
import {
  assertValidFilters,
  escapeRegExp,
  isDateRangeFilter,
  isFilterGroup,
  parseIsoDate,
  MAX_FILTER_FIELD_LENGTH,
  type DataFilter,
  type FilterNode,
  type FilterScalar,
} from '../filters/filter-tree.js';

const COMPARISON = { gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' } as const;

/**
 * Valida el nombre de un campo de MongoDB. Se admiten rutas con punto (`cliente.id`), pero ningún segmento
 * puede estar vacío ni empezar por `$`: así un campo nunca se interpreta como operador (`$where`, `$expr`...).
 */
export function assertMongoFieldName(field: unknown): asserts field is string {
  if (
    typeof field !== 'string' ||
    !field.trim() ||
    field.length > MAX_FILTER_FIELD_LENGTH ||
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
 * Rango de fechas: MongoDB no compara un Date con un texto, así que se buscan ambas formas (campo Date o texto ISO).
 */
function dateRange(field: string, bounds: Record<string, string>): Record<string, unknown> {
  const asDates = Object.fromEntries(Object.entries(bounds).map(([operator, value]) => [operator, new Date(parseIsoDate(value)!)]));
  return { $or: [{ [field]: asDates }, { [field]: bounds }] };
}

function leaf(filter: DataFilter): Record<string, unknown> {
  assertMongoFieldName(filter.campo);
  const field = filter.campo;
  const value = filter.valor;

  switch (filter.operador) {
    case 'isNull':
      // { $eq: null } también encuentra documentos sin el campo, igual que IS NULL en SQL.
      return { [field]: value === true ? { $eq: null } : { $ne: null } };
    case 'eq':
      return { [field]: { $eq: value } };
    case 'neq':
      // Como en SQL, `campo <> x` no incluye documentos donde el campo es null o no existe.
      return { [field]: value === null ? { $ne: null } : { $nin: [value, null] } };
    case 'in':
      return { [field]: { $in: [...(value as FilterScalar[])] } };
    case 'not-in':
      return { [field]: { $nin: [...(value as FilterScalar[]), null] } };
    case 'between': {
      const [min, max] = value as [string | number, string | number];
      if (isDateRangeFilter(filter)) return dateRange(field, { $gte: min as string, $lte: max as string });
      return { [field]: { $gte: min, $lte: max } };
    }
    case 'contains':
    case 'startsWith': {
      const pattern = escapeRegExp(String(value));
      return { [field]: { $regex: filter.operador === 'contains' ? pattern : `^${pattern}`, $options: 'i' } };
    }
    default: {
      const operator = COMPARISON[filter.operador as keyof typeof COMPARISON];
      if (!operator) throw new BadRequestException('El operador de filtro no está soportado');
      if (isDateRangeFilter(filter)) return dateRange(field, { [operator]: value as string });
      return { [field]: { [operator]: value } };
    }
  }
}

function node(filter: FilterNode): Record<string, unknown> {
  if (!isFilterGroup(filter)) return leaf(filter);
  const parts = filter.filtros.map(node);
  if (parts.length === 1) return parts[0];
  return { [filter.logica === 'OR' ? '$or' : '$and']: parts };
}

/**
 * Traduce los filtros del cross-join a un filtro de MongoDB (filter pushdown), con grupos AND/OR ($and/$or).
 * Los valores solo pueden ser escalares, nunca objetos, así que no se pueden inyectar operadores como
 * `{ $gt: '' }` o `$where`; contains/startsWith escapan el texto para usarlo literalmente en $regex.
 * Varios filtros de primer nivel se combinan con `$and`.
 */
export function buildMongoFilter(filters: readonly FilterNode[] = []): Record<string, unknown> {
  assertValidFilters(filters);
  const conditions = filters.map(node);
  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
}
