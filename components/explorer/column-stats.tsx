'use client';

import { useMemo } from 'react';
import { Modal } from '@/components/app-shell/modal';

type Row = Record<string, unknown>;

const typeOf = (value: unknown) => (value === null || value === undefined ? 'vacío' : Array.isArray(value) ? 'lista' : typeof value === 'object' ? 'objeto' : typeof value === 'number' ? 'número' : typeof value === 'boolean' ? 'booleano' : /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? 'fecha' : 'texto');
const show = (value: unknown) => (value === null || value === undefined ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value));

/**
 * Perfil rápido de una columna sobre la página cargada: tipos, vacíos, valores distintos, mínimo/máximo, promedio
 * (numéricas) y valores más frecuentes. Sirve para entender un campo antes de filtrarlo o cruzarlo.
 */
export function ColumnStats({ column, rows, onClose, onFilter }: Readonly<{ column: string; rows: Row[]; onClose: () => void; onFilter: (value: unknown) => void }>) {
  const stats = useMemo(() => {
    const values = rows.map((row) => row[column]);
    const present = values.filter((value) => value !== null && value !== undefined);
    const types = new Map<string, number>();
    for (const value of values) types.set(typeOf(value), (types.get(typeOf(value)) ?? 0) + 1);
    const counts = new Map<string, { value: unknown; count: number }>();
    for (const value of present) {
      const key = show(value);
      counts.set(key, { value, count: (counts.get(key)?.count ?? 0) + 1 });
    }
    const numbers = present.filter((value): value is number => typeof value === 'number');
    const sortable = numbers.length === present.length ? numbers : present.filter((value) => typeof value === 'string').map(String).sort();
    return {
      total: values.length,
      empty: values.length - present.length,
      distinct: counts.size,
      types: [...types.entries()].sort((a, b) => b[1] - a[1]),
      min: numbers.length === present.length && numbers.length ? Math.min(...numbers) : sortable[0],
      max: numbers.length === present.length && numbers.length ? Math.max(...numbers) : sortable.at(-1),
      avg: numbers.length && numbers.length === present.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null,
      top: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    };
  }, [rows, column]);

  return (
    <Modal title={`Estadísticas de ${column}`} description={`Sobre los ${stats.total} registros de esta página.`} onClose={onClose} footer={<button className="button form-secondary" type="button" onClick={onClose}>Cerrar</button>}>
      <dl className="inspector-grid">
        <div><dt>Tipo</dt><dd>{stats.types.map(([type, count]) => `${type} (${count})`).join(', ')}</dd></div>
        <div><dt>Vacíos</dt><dd>{stats.empty} ({stats.total ? Math.round((stats.empty / stats.total) * 100) : 0}%)</dd></div>
        <div><dt>Valores distintos</dt><dd>{stats.distinct}{stats.distinct === stats.total - stats.empty && stats.distinct >= 10 ? ' · todos únicos (posible llave)' : ''}</dd></div>
        <div><dt>Mínimo / máximo</dt><dd>{stats.min === undefined ? '—' : `${show(stats.min)} → ${show(stats.max)}`}</dd></div>
        {stats.avg !== null && <div><dt>Promedio</dt><dd>{stats.avg.toLocaleString('es', { maximumFractionDigits: 2 })}</dd></div>}
      </dl>
      <p className="field-label">Valores más frecuentes</p>
      <ul className="value-bars">
        {stats.top.map((item) => (
          <li key={show(item.value)}>
            <button type="button" className="value-bar" onClick={() => onFilter(item.value)} title="Filtrar por este valor">
              <span className="value-bar-fill" data-pct={Math.round((item.count / Math.max(stats.total, 1)) * 10) * 10} />
              <span className="value-bar-label">{show(item.value)}</span>
              <span className="value-bar-count">{item.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
