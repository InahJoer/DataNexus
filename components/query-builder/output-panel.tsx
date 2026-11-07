'use client';

import { Icon } from '@/components/icons';
import {
  AGGREGATIONS,
  OPERATORS,
  uid,
  type Aggregation,
  type Operator,
  type QbColumn,
  type QbMetric,
  type QbModel,
  type QbSource,
} from '@/components/query-builder/model';

type Tab = 'source' | 'columns' | 'group' | 'sort';
type PanelProps = Readonly<{
  model: QbModel;
  tab: Tab;
  onTab: (tab: Tab) => void;
  selected: QbSource | null;
  /** Columnas que producirá el cruce (con nombre calificado si se repite entre fuentes). */
  outputColumns: { name: string; type: string; sensitive: boolean }[];
  update: (recipe: (model: QbModel) => QbModel) => void;
}>;

const NUMERIC_OPS: Aggregation[] = ['SUM', 'AVG', 'MIN', 'MAX'];

const OP_PREFIX: Record<Aggregation, string> = { COUNT: 'conteo', COUNT_DISTINCT: 'distintos', SUM: 'suma', AVG: 'promedio', MIN: 'minimo', MAX: 'maximo' };
/** Nombre sugerido de una métrica (conteo, suma_total…), único entre las métricas existentes. */
function metricName(operation: Aggregation, field: string, taken: string[]): string {
  const base = [OP_PREFIX[operation], field.split('.').pop()?.replace(/[^A-Za-z0-9_]/g, '_')].filter(Boolean).join('_');
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}_${n}`;
  return name;
}
/** Renombra la métrica solo si el usuario no le puso un nombre propio. */
function renameIfAuto(item: QbMetric, next: QbMetric, all: QbMetric[]): QbMetric {
  const others = all.filter((other) => other.id !== item.id).map((other) => other.as);
  const auto = !item.as || item.as === metricName(item.operation, item.field, others);
  return auto ? { ...next, as: metricName(next.operation, next.field, others) } : next;
}

/** Panel derecho del Query Builder: filtros de la fuente elegida y configuración de la salida. */
export function OutputPanel({ model, tab, onTab, selected, outputColumns, update }: PanelProps) {
  const setSource = (id: string, recipe: (source: QbSource) => QbSource) =>
    update((current) => ({ ...current, sources: current.sources.map((source) => (source.id === id ? recipe(source) : source)) }));
  const columns: QbColumn[] = model.columns.length ? model.columns : outputColumns.map((column) => ({ name: column.name, visible: true, alias: '' }));
  const setColumns = (next: QbColumn[]) => update((current) => ({ ...current, columns: next }));
  const aggregated = model.groupBy.length > 0 || model.metrics.length > 0;
  const typeOfColumn = (name: string) => outputColumns.find((column) => column.name === name)?.type ?? '';

  return (
    <aside className="qb-panel" aria-label="Configuración de la consulta">
      <div className="segmented qb-panel-tabs" role="tablist">
        {([['source', 'Fuente'], ['columns', 'Columnas'], ['group', 'Agrupar'], ['sort', 'Orden']] as const).map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} aria-pressed={tab === value} onClick={() => onTab(value)}>{label}</button>
        ))}
      </div>

      {tab === 'source' && (selected ? (
        <section className="qb-section">
          <h3>{selected.alias}<small>{selected.entity} · {selected.connectionName}</small></h3>
          <label className="form-field"><span>Alias</span>
            <input className="form-input" value={selected.alias} maxLength={32} onChange={({ target: { value } }) => setSource(selected.id, (source) => ({ ...source, alias: value.replace(/[^A-Za-z0-9_]/g, '') || source.alias }))} />
          </label>
          <div className="qb-section-head">
            <strong>Condiciones (WHERE)</strong>
            {selected.filters.length > 1 && (
              <div className="segmented logic-toggle">
                <button type="button" aria-pressed={selected.logic === 'AND'} onClick={() => setSource(selected.id, (source) => ({ ...source, logic: 'AND' }))}>Y</button>
                <button type="button" aria-pressed={selected.logic === 'OR'} onClick={() => setSource(selected.id, (source) => ({ ...source, logic: 'OR' }))}>O</button>
              </div>
            )}
          </div>
          {selected.filters.map((filter) => (
            <div className="qb-filter" key={filter.id}>
              <select className="form-input" value={filter.campo} onChange={({ target: { value } }) => setSource(selected.id, (source) => ({ ...source, filters: source.filters.map((item) => (item.id === filter.id ? { ...item, campo: value } : item)) }))} aria-label="Campo">
                <option value="">Campo…</option>
                {selected.fields.map((field) => <option key={field.name} value={field.name}>{field.name} ({field.type})</option>)}
              </select>
              <select className="form-input" value={filter.operador} onChange={({ target: { value } }) => setSource(selected.id, (source) => ({ ...source, filters: source.filters.map((item) => (item.id === filter.id ? { ...item, operador: value as Operator } : item)) }))} aria-label="Operador">
                {(Object.keys(OPERATORS) as Operator[]).map((operator) => <option key={operator} value={operator}>{OPERATORS[operator]}</option>)}
              </select>
              {filter.operador !== 'isNull' && (
                <input className="form-input" placeholder={filter.operador === 'in' ? 'a, b, c' : filter.operador === 'between' ? 'desde' : 'valor'} value={filter.valor}
                  type={selected.fields.find((field) => field.name === filter.campo)?.type === 'fecha' && filter.operador !== 'in' ? 'date' : 'text'}
                  onChange={({ target: { value } }) => setSource(selected.id, (source) => ({ ...source, filters: source.filters.map((item) => (item.id === filter.id ? { ...item, valor: value } : item)) }))} aria-label="Valor" />
              )}
              {filter.operador === 'between' && (
                <input className="form-input" placeholder="hasta" value={filter.valor2 ?? ''}
                  type={selected.fields.find((field) => field.name === filter.campo)?.type === 'fecha' ? 'date' : 'text'}
                  onChange={({ target: { value } }) => setSource(selected.id, (source) => ({ ...source, filters: source.filters.map((item) => (item.id === filter.id ? { ...item, valor2: value } : item)) }))} aria-label="Hasta" />
              )}
              <button type="button" className="row-action row-action--danger" aria-label="Quitar condición" onClick={() => setSource(selected.id, (source) => ({ ...source, filters: source.filters.filter((item) => item.id !== filter.id) }))}>×</button>
            </div>
          ))}
          <button type="button" className="row-action" onClick={() => setSource(selected.id, (source) => ({ ...source, filters: [...source.filters, { id: uid('f'), campo: '', operador: 'eq', valor: '' }] }))}>+ Agregar condición</button>
          <p className="field-help">Las condiciones se aplican en la fuente, antes del cruce (en el servidor cuando el motor lo permite).</p>
        </section>
      ) : (
        <p className="panel-empty">Selecciona una tarjeta del lienzo para editar su alias y sus condiciones.</p>
      ))}

      {tab === 'columns' && (
        <section className="qb-section">
          {aggregated && <p className="field-help"><Icon name="alert" size={11} /> Con agrupación, la salida son los campos agrupados y las métricas.</p>}
          <div className="column-manager-actions">
            <button type="button" className="row-action" onClick={() => setColumns(columns.map((column) => ({ ...column, visible: true })))}>Todas</button>
            <button type="button" className="row-action" onClick={() => setColumns(columns.map((column) => ({ ...column, visible: !/(^|\.)(_id|__[A-Za-z]+)$/.test(column.name) })))}>Sin internas</button>
          </div>
          <ol className="qb-columns">
            {columns.map((column, index) => {
              const sensitive = outputColumns.find((item) => item.name === column.name)?.sensitive;
              return (
                <li key={column.name} data-hidden={!column.visible || undefined}>
                  <input type="checkbox" checked={column.visible} aria-label={`Mostrar ${column.name}`} onChange={() => setColumns(columns.map((item, i) => (i === index ? { ...item, visible: !item.visible } : item)))} />
                  <span className="qb-col-name" title={`${column.name} (${typeOfColumn(column.name)})`}>{column.name}{sensitive && <Icon name="eye-off" size={11} />}</span>
                  <input className="form-input qb-alias" placeholder="alias" value={column.alias} maxLength={120} aria-label={`Alias de ${column.name}`} onChange={(event) => setColumns(columns.map((item, i) => (i === index ? { ...item, alias: event.target.value } : item)))} />
                  <button type="button" aria-label="Subir" disabled={index === 0} onClick={() => { const next = [...columns]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setColumns(next); }}>↑</button>
                  <button type="button" aria-label="Bajar" disabled={index === columns.length - 1} onClick={() => { const next = [...columns]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setColumns(next); }}>↓</button>
                </li>
              );
            })}
          </ol>
          {outputColumns.some((column) => column.sensitive) && <p className="field-help"><Icon name="eye-off" size={11} /> Las columnas marcadas parecen sensibles: se enmascaran para los roles sin acceso.</p>}
        </section>
      )}

      {tab === 'group' && (
        <section className="qb-section">
          <strong>Agrupar por</strong>
          <div className="qb-chips">
            {model.groupBy.map((field) => <span key={field} className="filter-chip">{field}<button type="button" aria-label={`Quitar ${field}`} onClick={() => update((current) => ({ ...current, groupBy: current.groupBy.filter((item) => item !== field) }))}><Icon name="close" size={11} /></button></span>)}
            <select className="form-input compact-select" value="" aria-label="Agregar campo de agrupación" onChange={({ target: { value } }) => value && update((current) => ({ ...current, groupBy: [...current.groupBy, value] }))}>
              <option value="">+ Campo…</option>
              {outputColumns.filter((column) => !model.groupBy.includes(column.name)).map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
            </select>
          </div>
          <strong>Métricas</strong>
          {model.metrics.map((metric) => (
            <div className="qb-filter" key={metric.id}>
              <select className="form-input" value={metric.operation} aria-label="Operación" onChange={({ target: { value } }) => update((current) => ({ ...current, metrics: current.metrics.map((item) => (item.id === metric.id ? renameIfAuto(item, { ...item, operation: value as Aggregation }, current.metrics) : item)) }))}>
                {(Object.keys(AGGREGATIONS) as Aggregation[]).map((operation) => <option key={operation} value={operation}>{AGGREGATIONS[operation]}</option>)}
              </select>
              <select className="form-input" value={metric.field} aria-label="Campo" onChange={({ target: { value } }) => update((current) => ({ ...current, metrics: current.metrics.map((item) => (item.id === metric.id ? renameIfAuto(item, { ...item, field: value }, current.metrics) : item)) }))}>
                <option value="">{metric.operation === 'COUNT' ? '(todas las filas)' : 'Campo…'}</option>
                {outputColumns.filter((column) => !NUMERIC_OPS.includes(metric.operation) || column.type === 'número').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
              </select>
              <input className="form-input" value={metric.as} placeholder="nombre" aria-label="Nombre de la métrica" onChange={({ target: { value } }) => update((current) => ({ ...current, metrics: current.metrics.map((item) => (item.id === metric.id ? { ...item, as: value } : item)) }))} />
              <button type="button" className="row-action row-action--danger" aria-label="Quitar métrica" onClick={() => update((current) => ({ ...current, metrics: current.metrics.filter((item) => item.id !== metric.id) }))}>×</button>
            </div>
          ))}
          <button type="button" className="row-action" onClick={() => update((current) => ({ ...current, metrics: [...current.metrics, { id: uid('m'), operation: 'COUNT', field: '', as: metricName('COUNT', '', current.metrics.map((item) => item.as)) }] }))}>+ Agregar métrica</button>
          <p className="field-help">Como una tabla dinámica: una fila por cada combinación de los campos agrupados.</p>
        </section>
      )}

      {tab === 'sort' && (
        <section className="qb-section">
          <strong>Ordenar por (ORDER BY)</strong>
          {model.sort.map((item, index) => (
            <div className="qb-filter" key={`${item.campo}-${index}`}>
              <span className="qb-col-name">{item.campo}</span>
              <div className="segmented logic-toggle">
                {(['ASC', 'DESC'] as const).map((direction) => (
                  <button key={direction} type="button" aria-pressed={item.direccion === direction} onClick={() => update((current) => ({ ...current, sort: current.sort.map((sort, i) => (i === index ? { ...sort, direccion: direction } : sort)) }))}>{direction === 'ASC' ? '↑ Asc' : '↓ Desc'}</button>
                ))}
              </div>
              <button type="button" className="row-action row-action--danger" aria-label="Quitar orden" onClick={() => update((current) => ({ ...current, sort: current.sort.filter((_, i) => i !== index) }))}>×</button>
            </div>
          ))}
          {model.sort.length < 5 && (
            <select className="form-input compact-select" value="" aria-label="Agregar orden" onChange={(event) => { const campo = event.target.value; if (campo) update((current) => ({ ...current, sort: [...current.sort, { campo, direccion: 'ASC' }] })); }}>
              <option value="">+ Columna…</option>
              {(aggregated ? [...model.groupBy, ...model.metrics.map((metric) => metric.as)] : outputColumns.map((column) => column.name))
                .filter((name) => !model.sort.some((item) => item.campo === name))
                .map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          <label className="form-field"><span>Límite de filas</span>
            <select className="form-input" value={model.limit ?? ''} onChange={({ target: { value } }) => update((current) => ({ ...current, limit: value ? (Number(value) as QbModel['limit']) : null }))}>
              <option value="">Sin límite</option>
              {[50, 100, 500, 1000].map((value) => <option key={value} value={value}>Primeras {value}</option>)}
            </select>
          </label>
        </section>
      )}
    </aside>
  );
}
