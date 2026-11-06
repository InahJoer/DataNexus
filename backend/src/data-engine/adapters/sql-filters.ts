import { BadRequestException } from '@nestjs/common';
import { FILTER_OPERATORS, type DataFilter } from '../dto/cross-join.dto.js';

const COMPARISON_OPERATORS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;
const MAX_LIST_VALUES = 10;

export interface SqlDialect {
  /** Identificador ya escapado y calificado (p. ej. `src`.`campo`). */
  column(name: string): string;
  /** Marcador del parámetro (`@p` en SQL Server, `?` en MySQL) y registro del valor. */
  parameter(value: string | number | boolean): string;
}

export function isScalarFilterValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Traduce los filtros del cross-join a cláusulas WHERE parametrizadas (filter pushdown).
 * Solo admite campos que existen en la tabla y valores escalares; los valores nunca se concatenan al SQL.
 */
export function buildSqlFilterClauses(columns: readonly string[], filters: readonly DataFilter[], dialect: SqlDialect): string[] {
  const columnSet = new Set(columns);
  const supported = new Set<string>(FILTER_OPERATORS);
  const clauses: string[] = [];

  for (const filter of filters) {
    if (!filter || typeof filter.campo !== 'string' || !columnSet.has(filter.campo)) {
      throw new BadRequestException('El campo de filtro no existe en la tabla');
    }
    if (!supported.has(filter.operador)) {
      throw new BadRequestException('El operador de filtro no está soportado');
    }

    const column = dialect.column(filter.campo);
    if (filter.operador === 'eq' && filter.valor === null) {
      clauses.push(`${column} IS NULL`);
      continue;
    }
    if (filter.operador === 'neq' && filter.valor === null) {
      clauses.push(`${column} IS NOT NULL`);
      continue;
    }

    if (filter.operador === 'in' || filter.operador === 'not-in') {
      if (
        !Array.isArray(filter.valor) ||
        filter.valor.length === 0 ||
        filter.valor.length > MAX_LIST_VALUES ||
        filter.valor.some((value) => value === null || !isScalarFilterValue(value))
      ) {
        throw new BadRequestException('El valor del filtro de lista no es válido');
      }
      const placeholders = filter.valor.map((value) => dialect.parameter(value as string | number | boolean));
      clauses.push(`${column} ${filter.operador === 'in' ? 'IN' : 'NOT IN'} (${placeholders.join(', ')})`);
      continue;
    }

    const operator = COMPARISON_OPERATORS[filter.operador as keyof typeof COMPARISON_OPERATORS];
    if (!operator) throw new BadRequestException('El operador de filtro no está soportado');
    if (!isScalarFilterValue(filter.valor)) throw new BadRequestException('El valor del filtro no es válido');
    clauses.push(`${column} ${operator} ${dialect.parameter(filter.valor)}`);
  }

  return clauses;
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
