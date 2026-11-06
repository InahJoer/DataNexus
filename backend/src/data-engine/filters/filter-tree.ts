import { BadRequestException } from '@nestjs/common';

/**
 * Filtros de un cross-join (RF-15). Un filtro es una condición sobre un campo o un grupo AND/OR de filtros.
 * La lista de filtros de una fuente se combina con AND.
 */
export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not-in',
  'between',
  'contains',
  'startsWith',
  'isNull',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type FilterScalar = string | number | boolean | null;
export type FilterValue = FilterScalar | FilterScalar[];

export const FILTER_LOGIC = ['AND', 'OR'] as const;
export type FilterLogic = (typeof FILTER_LOGIC)[number];

export interface DataFilter {
  campo: string;
  operador: FilterOperator;
  valor: FilterValue;
}

export interface FilterGroup {
  logica: FilterLogic;
  filtros: FilterNode[];
}

export type FilterNode = DataFilter | FilterGroup;

/** Niveles de anidación de grupos y condiciones totales por fuente. */
export const MAX_FILTER_DEPTH = 3;
export const MAX_FILTER_CONDITIONS = 20;
export const MAX_LIST_VALUES = 10;
export const MAX_TEXT_FILTER_LENGTH = 200;
export const MAX_FILTER_FIELD_LENGTH = 150;

/** Límites de filas de un resultado que el usuario puede elegir (RF-16). */
export const ROW_LIMIT_OPTIONS = [50, 100, 500, 1000] as const;
export type RowLimitOption = (typeof ROW_LIMIT_OPTIONS)[number];

export function isFilterGroup(node: unknown): node is FilterGroup {
  return typeof node === 'object' && node !== null && 'logica' in node;
}

export function isScalarFilterValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/** Motivo por el que una condición no es válida, o null si lo es. */
function leafError(filter: Partial<DataFilter>): string | null {
  if (
    typeof filter.campo !== 'string' ||
    !filter.campo.trim() ||
    filter.campo.length > MAX_FILTER_FIELD_LENGTH ||
    filter.campo.includes('\0')
  ) {
    return 'campo debe ser un nombre de campo de 1 a 150 caracteres';
  }
  const value: unknown = filter.valor;
  switch (filter.operador) {
    case 'eq':
    case 'neq':
      return value === null || isScalarFilterValue(value) ? null : `${filter.operador} necesita un valor escalar o null`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return isScalarFilterValue(value) ? null : `${filter.operador} necesita un valor escalar`;
    case 'in':
    case 'not-in':
      return Array.isArray(value) &&
        value.length > 0 &&
        value.length <= MAX_LIST_VALUES &&
        value.every((entry) => isScalarFilterValue(entry))
        ? null
        : `${filter.operador} necesita una lista de 1 a ${MAX_LIST_VALUES} valores escalares`;
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) return 'between necesita [mínimo, máximo]';
      const [min, max] = value;
      const sameType =
        (typeof min === 'number' && typeof max === 'number' && Number.isFinite(min) && Number.isFinite(max)) ||
        (typeof min === 'string' && typeof max === 'string');
      if (!sameType) return 'between necesita dos números o dos textos (por ejemplo, fechas ISO)';
      return min <= max ? null : 'en between el mínimo no puede ser mayor que el máximo';
    }
    case 'contains':
    case 'startsWith':
      return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_FILTER_LENGTH
        ? null
        : `${filter.operador} necesita un texto de 1 a ${MAX_TEXT_FILTER_LENGTH} caracteres`;
    case 'isNull':
      return typeof value === 'boolean' ? null : 'isNull necesita true (es nulo) o false (no es nulo)';
    default:
      return `operador debe ser uno de: ${FILTER_OPERATORS.join(', ')}`;
  }
}

/**
 * Valida una lista de filtros (grupos incluidos) y devuelve el primer error en español, o null si es válida.
 * Lo usan el DTO (400 con mensaje claro) y los adaptadores (defensa en profundidad).
 */
export function describeFilterError(nodes: unknown): string | null {
  if (nodes === undefined) return null;
  if (!Array.isArray(nodes)) return 'los filtros deben ser una lista';
  let conditions = 0;

  const visit = (list: unknown[], depth: number): string | null => {
    for (const node of list) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return 'cada filtro debe ser un objeto';
      if (isFilterGroup(node)) {
        if (depth >= MAX_FILTER_DEPTH) return `los grupos de filtros admiten como máximo ${MAX_FILTER_DEPTH} niveles`;
        if (!FILTER_LOGIC.includes(node.logica)) return 'logica debe ser AND u OR';
        if (!Array.isArray(node.filtros) || node.filtros.length === 0) return 'un grupo necesita al menos un filtro';
        const nested = visit(node.filtros, depth + 1);
        if (nested) return nested;
        continue;
      }
      conditions += 1;
      if (conditions > MAX_FILTER_CONDITIONS) return `se admiten como máximo ${MAX_FILTER_CONDITIONS} condiciones por fuente`;
      const error = leafError(node as Partial<DataFilter>);
      if (error) return error;
    }
    return null;
  };
  return visit(nodes, 0);
}

export function assertValidFilters(nodes: unknown): asserts nodes is FilterNode[] | undefined {
  const error = describeFilterError(nodes);
  if (error) throw new BadRequestException(`Filtro no válido: ${error}`);
}

/** Número de condiciones (hojas) de una lista de filtros, para la bitácora. */
export function countConditions(nodes: readonly FilterNode[] | undefined): number {
  return (nodes ?? []).reduce((total, node) => total + (isFilterGroup(node) ? countConditions(node.filtros) : 1), 0);
}

/**
 * Separa los filtros que el motor puede ejecutar (`pushed`) de los que se evalúan en memoria (`residual`).
 * Se decide por cada filtro de primer nivel (que se combinan con AND): un grupo se envía al motor solo si todas
 * sus condiciones se pueden enviar. El resultado es el mismo que evaluar todo en memoria.
 */
export function splitFiltersForPushdown(
  nodes: readonly FilterNode[] | undefined,
  canPush: (filter: DataFilter) => boolean,
  canPushGroups = true,
): { pushed: FilterNode[]; residual: FilterNode[] } {
  const pushed: FilterNode[] = [];
  const residual: FilterNode[] = [];
  const pushable = (node: FilterNode): boolean =>
    isFilterGroup(node) ? canPushGroups && node.filtros.every(pushable) : canPush(node);
  for (const node of nodes ?? []) (pushable(node) ? pushed : residual).push(node);
  return { pushed, residual };
}

function fieldValue(record: Record<string, unknown>, field: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, field)) return record[field];
  // Campos anidados con punto (documentos NoSQL): cliente.id
  if (!field.includes('.')) return undefined;
  let current: unknown = record;
  for (const segment of field.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const isNullish = (value: unknown) => value === null || value === undefined;

/** Compara como lo haría la base: números como números (también si llegan como texto numérico), el resto como texto. */
function compare(left: unknown, right: unknown): number | null {
  if (isNullish(left) || isNullish(right)) return null;
  const leftNumber = typeof left === 'number' ? left : typeof left === 'string' && left.trim() !== '' ? Number(left) : NaN;
  const rightNumber = typeof right === 'number' ? right : typeof right === 'string' && right.trim() !== '' ? Number(right) : NaN;
  if ((typeof left === 'number' || typeof right === 'number') && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right ? 0 : null;
  const a = asText(left);
  const b = asText(right);
  // Objetos y listas no se comparan con escalares (como en SQL, no hay coincidencia).
  if (a === null || b === null) return null;
  return a === b ? 0 : a < b ? -1 : 1;
}

function asText(value: unknown): string | null {
  if (isNullish(value)) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return null;
}

function matchesLeaf(record: Record<string, unknown>, filter: DataFilter): boolean {
  const value = fieldValue(record, filter.campo);
  switch (filter.operador) {
    case 'isNull':
      return filter.valor === true ? isNullish(value) : !isNullish(value);
    case 'eq':
      return filter.valor === null ? isNullish(value) : compare(value, filter.valor) === 0;
    case 'neq':
      if (filter.valor === null) return !isNullish(value);
      // Como en SQL, `campo <> x` no incluye las filas donde el campo es NULL.
      return !isNullish(value) && compare(value, filter.valor) !== 0;
    case 'gt': {
      const result = compare(value, filter.valor);
      return result !== null && result > 0;
    }
    case 'gte': {
      const result = compare(value, filter.valor);
      return result !== null && result >= 0;
    }
    case 'lt': {
      const result = compare(value, filter.valor);
      return result !== null && result < 0;
    }
    case 'lte': {
      const result = compare(value, filter.valor);
      return result !== null && result <= 0;
    }
    case 'in':
      return (filter.valor as FilterScalar[]).some((entry) => compare(value, entry) === 0);
    case 'not-in':
      return !isNullish(value) && !(filter.valor as FilterScalar[]).some((entry) => compare(value, entry) === 0);
    case 'between': {
      const [min, max] = filter.valor as [FilterScalar, FilterScalar];
      const low = compare(value, min);
      const high = compare(value, max);
      return low !== null && high !== null && low >= 0 && high <= 0;
    }
    case 'contains':
    case 'startsWith': {
      const text = asText(value);
      if (text === null) return false;
      const needle = String(filter.valor).toLowerCase();
      const haystack = text.toLowerCase();
      return filter.operador === 'contains' ? haystack.includes(needle) : haystack.startsWith(needle);
    }
    default:
      return false;
  }
}

/** Evalúa los filtros en memoria con la misma semántica que el pushdown (texto sin distinguir mayúsculas). */
export function matchesFilters(record: Record<string, unknown>, nodes: readonly FilterNode[] | undefined): boolean {
  return (nodes ?? []).every((node) => matchesNode(record, node));
}

function matchesNode(record: Record<string, unknown>, node: FilterNode): boolean {
  if (!isFilterGroup(node)) return matchesLeaf(record, node);
  return node.logica === 'AND'
    ? node.filtros.every((child) => matchesNode(record, child))
    : node.filtros.some((child) => matchesNode(record, child));
}

/** Escapa los comodines de LIKE con `!` (válido en PostgreSQL, MySQL y SQL Server). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[!%_[]/g, (char) => `!${char}`);
}

/** Escapa un texto para usarlo literalmente dentro de una expresión regular. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Lee los filtros enviados como JSON en la query string (`?filtros=[...]`) y los valida. */
export function parseFilterQuery(raw: string | undefined): FilterNode[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('Filtro no válido: filtros debe ser una lista en JSON');
  }
  assertValidFilters(parsed);
  return parsed;
}
