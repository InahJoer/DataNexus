'use client';

import { useState } from 'react';
import { Icon } from '@/components/icons';

export type ColumnSetting = { name: string; visible: boolean };

/** Mezcla las columnas de un resultado nuevo con la configuración actual: conserva orden y visibilidad conocidos. */
export function mergeColumns(current: ColumnSetting[], available: string[]): ColumnSetting[] {
  const known = current.filter((column) => available.includes(column.name));
  const added = available.filter((name) => !current.some((column) => column.name === name)).map((name) => ({ name, visible: true }));
  return [...known, ...added];
}

type ColumnManagerProps = Readonly<{ columns: ColumnSetting[]; onChange: (columns: ColumnSetting[]) => void }>;

/**
 * Columnas del resultado: qué se ve y en qué orden. La misma selección se usa en la exportación y al guardar la
 * consulta (y por tanto en los reportes programados). Se reordena arrastrando o con las flechas.
 */
export function ColumnManager({ columns, onChange }: ColumnManagerProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const visible = columns.filter((column) => column.visible).length;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= columns.length || from === to) return;
    const next = [...columns];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };
  const toggle = (index: number) => onChange(columns.map((column, i) => (i === index ? { ...column, visible: !column.visible } : column)));
  const setAll = (value: boolean | ((name: string) => boolean)) =>
    onChange(columns.map((column) => ({ ...column, visible: typeof value === 'function' ? value(column.name) : value })));
  const term = filter.trim().toLowerCase();

  return (
    <aside className="column-manager" aria-label="Columnas del resultado">
      <header>
        <strong>Columnas</strong>
        <span>{visible} de {columns.length} visibles</span>
      </header>
      <div className="column-manager-actions">
        <button type="button" className="row-action" onClick={() => setAll(true)}>Todas</button>
        <button type="button" className="row-action" onClick={() => setAll((name) => !name.includes('__') && !/(^|\.)_id$/.test(name))}>Sin internas</button>
        <button type="button" className="row-action" onClick={() => setAll(false)} disabled={visible === 0}>Ninguna</button>
      </div>
      {columns.length > 8 && (
        <label className="search-field column-search">
          <Icon name="search" size={13} />
          <input type="search" placeholder="Buscar columna" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Buscar columna" />
        </label>
      )}
      <ol className="column-list">
        {columns.map((column, index) => (term && !column.name.toLowerCase().includes(term) ? null : (
          <li
            key={column.name}
            draggable
            data-dragging={dragging === index || undefined}
            data-hidden={!column.visible || undefined}
            onDragStart={() => setDragging(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragging !== null) move(dragging, index);
              setDragging(null);
            }}
            onDragEnd={() => setDragging(null)}
          >
            <span className="column-grip" aria-hidden="true">⋮⋮</span>
            <label>
              <input type="checkbox" checked={column.visible} onChange={() => toggle(index)} />
              <span title={column.name}>{column.name}</span>
            </label>
            <button type="button" aria-label={`Subir ${column.name}`} disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button>
            <button type="button" aria-label={`Bajar ${column.name}`} disabled={index === columns.length - 1} onClick={() => move(index, index + 1)}>↓</button>
          </li>
        )))}
      </ol>
      <p className="field-help"><Icon name="arrow-up-right" size={11} /> La exportación y la consulta guardada usan estas columnas y este orden.</p>
    </aside>
  );
}
