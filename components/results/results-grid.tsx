'use client';

import { useMemo, useState } from 'react';
import { Icon } from '@/components/icons';

type Row = Record<string, unknown>;
export type GridSort = { column: string; direction: 'asc' | 'desc' } | null;
type Sort = GridSort;

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Valores que el backend enmascaró para el rol (correo, teléfono, FULL o HASH): se resaltan en el grid. */
function isMasked(value: unknown) {
  return typeof value === 'string' && (/\*{3,}/.test(value) || /^hash:[0-9a-f]{8,}$/.test(value));
}

function compare(a: unknown, b: unknown) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return displayValue(a).localeCompare(displayValue(b), 'es', { numeric: true, sensitivity: 'base' });
}

/**
 * Data Grid de resultados (#46): encabezado fijo, orden por columna, filtro sobre la página cargada y resaltado de
 * campos enmascarados. La paginación del servidor la maneja quien lo usa.
 */
/**
 * `columns`: columnas visibles y su orden (editor de consultas); sin ella se muestran todas.
 * `sort` + `onSortChange`: orden controlado por quien lo usa (p. ej. el servidor ordena todo el resultado, no solo la página).
 */
export function ResultsGrid({ rows, caption, columns: chosen, sort: controlledSort, onSortChange }: Readonly<{ rows: Row[]; caption: string; columns?: string[]; sort?: Sort; onSortChange?: (sort: Sort) => void }>) {
  const [localSort, setLocalSort] = useState<Sort>(null);
  const sort = onSortChange ? (controlledSort ?? null) : localSort;
  const [filter, setFilter] = useState('');
  const columns = useMemo(() => chosen ?? [...new Set(rows.flatMap((row) => Object.keys(row)))], [rows, chosen]);
  const maskedCount = useMemo(() => rows.reduce((count, row) => count + Object.values(row).filter(isMasked).length, 0), [rows]);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const filtered = term ? rows.filter((row) => columns.some((column) => displayValue(row[column]).toLowerCase().includes(term))) : rows;
    if (!sort || onSortChange) return filtered;
    const sign = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => sign * compare(a[sort.column], b[sort.column]));
  }, [rows, columns, filter, sort, onSortChange]);

  const nextSort = (current: Sort, column: string): Sort =>
    current?.column !== column ? { column, direction: 'asc' } : current.direction === 'asc' ? { column, direction: 'desc' } : null;
  const toggleSort = (column: string) => (onSortChange ? onSortChange(nextSort(sort, column)) : setLocalSort((current) => nextSort(current, column)));

  return (
    <div className="results-grid">
      <div className="results-toolbar">
        <label className="search-field">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Filtrar en esta página" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filtrar resultados" />
        </label>
        <span className="results-meta">{columns.length} columnas{filter && ` · ${visible.length} de ${rows.length} filas coinciden`}</span>
        {maskedCount > 0 && <span className="masked-note"><Icon name="eye-off" size={13} />{maskedCount} valores enmascarados por tu rol</span>}
      </div>
      <div className="data-table-wrap results-scroll">
        <table className="data-table results-table">
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="results-index">#</th>
              {columns.map((column) => {
                const direction = sort?.column === column ? sort.direction : null;
                return (
                  <th scope="col" key={column} aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}>
                    <button type="button" className="sort-button" onClick={() => toggleSort(column)}>
                      {column}
                      <Icon name="chevron-down" size={12} className={direction ? `sort-icon sort-icon--${direction}` : 'sort-icon'} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr key={index}>
                <td className="results-index">{index + 1}</td>
                {columns.map((column) => {
                  const text = displayValue(row[column]);
                  return <td key={column} title={text} data-masked={isMasked(row[column]) || undefined} data-null={row[column] == null || undefined}>{text}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p className="page-message">Ninguna fila de esta página coincide con “{filter}”.</p>}
      </div>
    </div>
  );
}
