'use client';

import { useState, type FormEvent } from 'react';
import { Icon } from '@/components/icons';
import { OPERATORS, uid, type Operator, type QbFilter, type QbModel } from '@/components/query-builder/model';

type ResultFiltersProps = Readonly<{
  model: QbModel;
  /** Columnas de la tabla combinada tal como se ven (con su alias). */
  columns: string[];
  update: (recipe: (model: QbModel) => QbModel) => void;
}>;

const describe = (filter: QbFilter) => {
  if (filter.operador === 'isNull') return `${filter.campo} está vacío`;
  if (filter.operador === 'between') return `${filter.campo} entre ${filter.valor} y ${filter.valor2 ?? ''}`;
  if (filter.operador === 'in') return `${filter.campo} en (${filter.valor})`;
  return `${filter.campo} ${OPERATORS[filter.operador]} ${filter.valor}`;
};

/**
 * Filtros sobre la tabla ya combinada, como en el explorador: condiciones que se combinan con Y u O y se aplican a
 * todo el resultado en el servidor (también a la exportación y al reporte guardado). Con agrupación son un HAVING.
 */
export function ResultFilters({ model, columns, update }: ResultFiltersProps) {
  const [draft, setDraft] = useState<{ campo: string; operador: Operator; valor: string; valor2: string }>({ campo: '', operador: 'eq', valor: '', valor2: '' });
  const [error, setError] = useState<string | null>(null);
  const filters = model.resultFilters;
  const aggregated = model.groupBy.length > 0 || model.metrics.length > 0;

  function add(event: FormEvent) {
    event.preventDefault();
    if (!draft.campo.trim()) return setError('Elige una columna.');
    if (draft.operador !== 'isNull' && !draft.valor.trim()) return setError('Escribe un valor.');
    if (draft.operador === 'between' && !draft.valor2.trim()) return setError('Escribe el valor final del rango.');
    setError(null);
    const filter: QbFilter = { id: uid('rf'), campo: draft.campo.trim(), operador: draft.operador, valor: draft.operador === 'isNull' ? '' : draft.valor.trim(), ...(draft.operador === 'between' ? { valor2: draft.valor2.trim() } : {}) };
    update((current) => ({ ...current, resultFilters: [...current.resultFilters, filter] }));
    setDraft((value) => ({ ...value, valor: '', valor2: '' }));
  }

  return (
    <div className="qb-result-filters">
      <form className="filter-bar" onSubmit={add} aria-label="Filtrar la tabla combinada">
        <select className="form-input" value={draft.campo} onChange={({ target: { value } }) => setDraft((current) => ({ ...current, campo: value }))} aria-label="Columna">
          <option value="">Columna…</option>
          {columns.map((column) => <option key={column} value={column}>{column}</option>)}
        </select>
        <select className="form-input" value={draft.operador} onChange={({ target: { value } }) => setDraft((current) => ({ ...current, operador: value as Operator }))} aria-label="Operador">
          {(Object.keys(OPERATORS) as Operator[]).map((operator) => <option key={operator} value={operator}>{OPERATORS[operator]}</option>)}
        </select>
        {draft.operador !== 'isNull' && (
          <input className="form-input" placeholder={draft.operador === 'in' ? 'valor1, valor2…' : draft.operador === 'between' ? 'desde' : 'valor'} value={draft.valor} onChange={({ target: { value } }) => setDraft((current) => ({ ...current, valor: value }))} aria-label="Valor" />
        )}
        {draft.operador === 'between' && <input className="form-input" placeholder="hasta" value={draft.valor2} onChange={({ target: { value } }) => setDraft((current) => ({ ...current, valor2: value }))} aria-label="Valor final" />}
        <button type="submit" className="button form-secondary compact-button"><Icon name="search" size={13} />Filtrar</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {filters.length > 0 && (
        <div className="filter-chips" aria-label="Filtros del resultado">
          {filters.length > 1 && (
            <div className="segmented logic-toggle" role="group" aria-label="Combinar filtros">
              <button type="button" aria-pressed={model.resultLogic === 'AND'} onClick={() => update((current) => ({ ...current, resultLogic: 'AND' }))}>Y</button>
              <button type="button" aria-pressed={model.resultLogic === 'OR'} onClick={() => update((current) => ({ ...current, resultLogic: 'OR' }))}>O</button>
            </div>
          )}
          {filters.map((filter) => (
            <span key={filter.id} className="filter-chip">
              {describe(filter)}
              <button type="button" aria-label={`Quitar filtro ${describe(filter)}`} onClick={() => update((current) => ({ ...current, resultFilters: current.resultFilters.filter((item) => item.id !== filter.id) }))}>×</button>
            </span>
          ))}
          <button type="button" className="row-action" onClick={() => update((current) => ({ ...current, resultFilters: [] }))}>Quitar todos</button>
          {aggregated && <span className="field-help">Con agrupación filtran los grupos (como HAVING).</span>}
        </div>
      )}
    </div>
  );
}
