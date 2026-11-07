import { BadRequestException } from '@nestjs/common';
import {
  assertValidFilters,
  escapeLikePattern,
  parseIsoDate,
  isFilterGroup,
  type DataFilter,
  type FilterNode,
  type FilterScalar,
} from '../filters/filter-tree.js';

export { isScalarFilterValue } from '../filters/filter-tree.js';

const COMPARISON_OPERATORS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

export interface SqlDialect {
  /** Identificador ya escapado y calificado (p. ej. `src`.`campo`). */
  column(name: string): string;
  /** Marcador del parámetro (`@p` en SQL Server, `?` en MySQL, `$n` en PostgreSQL) y registro del valor. */
  parameter(value: string | number | boolean | Date): string;
  /** Convierte la columna a texto para contains/startsWith. Por defecto CAST(... AS VARCHAR(4000)). */
  text?(column: string): string;
}

/**
 * Traduce los filtros del cross-join a cláusulas WHERE parametrizadas (filter pushdown). Devuelve una cláusula
 * por filtro de primer nivel (se combinan con AND); los grupos AND/OR van entre paréntesis.
 * - Solo admite campos que existen en la tabla; los identificadores los escapa el dialecto.
 * - Los valores siempre van como parámetros, nunca concatenados al SQL.
 * - contains/startsWith usan LOWER(...) LIKE con los comodines escapados (`!`), así que un valor con `%` o `_`
 *   se busca literalmente.
 */
export function buildSqlFilterClauses(
  columns: readonly string[],
  filters: readonly FilterNode[],
  dialect: SqlDialect,
): string[] {
  assertValidFilters(filters);
  const columnSet = new Set(columns);
  const text = (column: string) => (dialect.text ? dialect.text(column) : `CAST(${column} AS VARCHAR(4000))`);
  // En rangos, una fecha ISO con hora se envía como Date para que el driver la compare como instante y no como texto.
  // Una fecha sola (2026-03-31) queda como texto: los motores la convierten bien a DATE, y como Date el driver la
  // enviaría en la zona horaria del servidor de la app y podría correrse un día.
  const rangeValue = (value: string | number | boolean) => {
    const time = typeof value === 'string' && /\d[T ]\d/.test(value) ? parseIsoDate(value) : null;
    return time === null ? value : new Date(time);
  };

  const leaf = (filter: DataFilter): string => {
    if (!columnSet.has(filter.campo)) throw new BadRequestException('El campo de filtro no existe en la tabla');
    const column = dialect.column(filter.campo);
    const value = filter.valor;

    switch (filter.operador) {
      case 'isNull':
        return value === true ? `${column} IS NULL` : `${column} IS NOT NULL`;
      case 'in':
      case 'not-in': {
        const placeholders = (value as FilterScalar[]).map((entry) => dialect.parameter(entry as string | number | boolean));
        return `${column} ${filter.operador === 'in' ? 'IN' : 'NOT IN'} (${placeholders.join(', ')})`;
      }
      case 'between': {
        const [min, max] = value as [string | number, string | number];
        return `${column} BETWEEN ${dialect.parameter(rangeValue(min))} AND ${dialect.parameter(rangeValue(max))}`;
      }
      case 'contains':
      case 'startsWith': {
        const pattern = escapeLikePattern(String(value).toLowerCase());
        const parameter = dialect.parameter(filter.operador === 'contains' ? `%${pattern}%` : `${pattern}%`);
        return `LOWER(${text(column)}) LIKE ${parameter} ESCAPE '!'`;
      }
      case 'eq':
        if (value === null) return `${column} IS NULL`;
        return `${column} = ${dialect.parameter(value as string | number | boolean)}`;
      case 'neq':
        if (value === null) return `${column} IS NOT NULL`;
        return `${column} <> ${dialect.parameter(value as string | number | boolean)}`;
      default: {
        const operator = COMPARISON_OPERATORS[filter.operador as keyof typeof COMPARISON_OPERATORS];
        if (!operator) throw new BadRequestException('El operador de filtro no está soportado');
        return `${column} ${operator} ${dialect.parameter(rangeValue(value as string | number | boolean))}`;
      }
    }
  };

  const node = (filter: FilterNode): string => {
    if (!isFilterGroup(filter)) return leaf(filter);
    const parts = filter.filtros.map(node);
    return parts.length === 1 ? parts[0] : `(${parts.join(filter.logica === 'OR' ? ' OR ' : ' AND ')})`;
  };

  return filters.map(node);
}

/** Nombre de columna auxiliar que no choque con las columnas reales (sin distinguir mayúsculas). */
export function uniqueColumnName(columns: readonly string[], preferred: string): string {
  const taken = new Set(columns.map((column) => column.toLowerCase()));
  let name = preferred;
  let suffix = 2;
  while (taken.has(name.toLowerCase())) {
    name = `${preferred}_${suffix}`;
    suffix += 1;
  }
  return name;
}
