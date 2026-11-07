/**
 * Columnas de salida elegidas en el editor de consultas: solo esas y en ese orden. Se aplica después del
 * enmascaramiento, así que ocultar una columna nunca expone otra. Una columna pedida que no existe sale en null
 * (por ejemplo, un campo que falta en algunos documentos). Sin lista, se devuelven todas.
 */
export function selectColumns<T extends Record<string, unknown>>(rows: T[], columns?: readonly string[]): Record<string, unknown>[] {
  if (!columns?.length) return rows;
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
}
