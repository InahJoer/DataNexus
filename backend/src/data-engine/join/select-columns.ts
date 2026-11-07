/**
 * Columnas de salida elegidas en el editor de consultas: solo esas y en ese orden. Se aplica después del
 * enmascaramiento, así que ocultar una columna nunca expone otra. Una columna pedida que no existe sale en null
 * (por ejemplo, un campo que falta en algunos documentos). Sin lista, se devuelven todas.
 * `aliases` renombra columnas en la salida (`{ "clientes.nombre": "Cliente" }`).
 */
export function selectColumns<T extends Record<string, unknown>>(
  rows: T[],
  columns?: readonly string[],
  aliases?: Readonly<Record<string, string>>,
): Record<string, unknown>[] {
  const hasAliases = aliases && Object.keys(aliases).length > 0;
  if (!columns?.length && !hasAliases) return rows;
  const rename = (column: string) => (hasAliases && aliases[column]) || column;
  return rows.map((row) => {
    const names = columns?.length ? columns : Object.keys(row);
    return Object.fromEntries(names.map((column) => [rename(column), row[column] ?? null]));
  });
}

export interface SortSpec {
  campo: string;
  direccion: 'ASC' | 'DESC';
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  // Los vacíos van siempre al final, en cualquier dirección.
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' });
}

/**
 * Orden del resultado por una o más columnas (ORDER BY). Es estable: a igual valor se conserva el orden del cruce.
 * Se aplica sobre los nombres originales de las columnas, antes de los alias.
 */
export function sortRows<T extends Record<string, unknown>>(rows: T[], order?: readonly SortSpec[]): T[] {
  if (!order?.length) return rows;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      for (const { campo, direccion } of order) {
        const a = left.row[campo];
        const b = right.row[campo];
        const nullish = a === null || a === undefined || b === null || b === undefined;
        const result = compareValues(a, b);
        if (result !== 0) return nullish || direccion === 'ASC' ? result : -result;
      }
      return left.index - right.index;
    })
    .map(({ row }) => row);
}
