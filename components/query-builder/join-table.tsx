'use client';

import { ENGINES, type Engine } from '@/components/connections/engines';
import { Icon } from '@/components/icons';
import {
  joinCompatibility,
  plan,
  uid,
  type JoinType,
  type LinkSuggestion,
  type QbLink,
  type QbModel,
  type QbSource,
} from '@/components/query-builder/model';

const JOIN_LABELS: Record<JoinType, string> = {
  INNER: 'INNER · solo coincidencias',
  LEFT: 'LEFT · todas las de la izquierda',
  RIGHT: 'RIGHT · todas las de la derecha',
  FULL: 'FULL · todas las de ambas',
};

type JoinTableProps = Readonly<{
  model: QbModel;
  suggestions: LinkSuggestion[];
  selectedSource: string | null;
  onSelectSource: (id: string) => void;
  onRemoveSource: (id: string) => void;
  update: (recipe: (model: QbModel) => QbModel) => void;
}>;

const fieldType = (source: QbSource | undefined, field: string) => source?.fields.find((item) => item.name === field)?.type ?? 'desconocido';

/**
 * Modo tabla del editor (como el editor clásico de cruces): una fila por fuente y una fila por unión, con listas para
 * elegir fuente, campo y tipo de join. Admite tantas uniones como fuentes (cruces encadenados y llaves compuestas) y
 * propone las uniones detectadas por nombre y por valores reales de la muestra.
 */
export function JoinTable({ model, suggestions, selectedSource, onSelectSource, onRemoveSource, update }: JoinTableProps) {
  const byId = (id: string) => model.sources.find((source) => source.id === id);
  const { order, relations, disconnected } = plan(model);

  const setLink = (id: string, recipe: (link: QbLink) => QbLink) =>
    update((current) => ({ ...current, links: current.links.map((link) => (link.id === id ? recipe(link) : link)) }));

  function addLink() {
    const best = suggestions[0]?.link;
    if (best) {
      update((current) => ({ ...current, links: [...current.links, { ...best, id: uid('l') }] }));
      return;
    }
    const [a, b] = model.sources;
    if (!a || !b) return;
    // Sin sugerencias: una fuente aún sin unir contra la primera, con sus primeros campos (el usuario los cambia).
    const target = disconnected[0] ?? b;
    const anchor = target.id === a.id ? b : a;
    update((current) => ({
      ...current,
      links: [...current.links, { id: uid('l'), from: { source: anchor.id, field: anchor.fields[0]?.name ?? '' }, to: { source: target.id, field: target.fields[0]?.name ?? '' }, type: 'INNER' }],
    }));
  }

  const applySuggestion = (suggestion: LinkSuggestion) =>
    update((current) => ({ ...current, links: [...current.links, { ...suggestion.link, id: uid('l') }] }));
  const applyAll = () =>
    update((current) => ({ ...current, links: [...current.links, ...suggestions.map((item) => ({ ...item.link, id: uid('l') }))] }));

  return (
    <div className="qb-table-mode">
      <section className="qb-block" aria-label="Fuentes del cruce">
        <header className="qb-block-head">
          <h3>Fuentes <small>{model.sources.length}</small></h3>
          <span className="field-help">Agrega tablas o colecciones desde la lista de la izquierda.</span>
        </header>
        {model.sources.length === 0 ? (
          <p className="panel-empty">Aún no hay fuentes. Haz clic en una tabla, colección o subcolección de la izquierda.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table qb-sources-table">
              <thead><tr><th>Alias</th><th>Origen</th><th>Campos</th><th>Filtros</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
              <tbody>
                {model.sources.map((source) => (
                  <tr key={source.id} data-selected={selectedSource === source.id || undefined}>
                    <td><strong>{source.alias}</strong>{disconnected.includes(source) && model.sources.length > 1 && <small className="cell-sub qb-warn">Sin unir</small>}</td>
                    <td>
                      <span className="qb-origin">
                        <span className="engine-badge" data-engine={source.engine}>{ENGINES[source.engine as Engine]?.short ?? '?'}</span>
                        <span>{source.entity}<small className="cell-sub">{source.connectionName}</small></span>
                      </span>
                    </td>
                    <td>{source.fields.length || '…'}</td>
                    <td>{source.filters.length ? `${source.filters.length} (${source.logic === 'OR' ? 'O' : 'Y'})` : '—'}</td>
                    <td className="cell-actions">
                      <button type="button" className="row-action" onClick={() => onSelectSource(source.id)}>Editar</button>
                      <button type="button" className="row-action row-action--danger" onClick={() => onRemoveSource(source.id)}>Quitar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="qb-block" aria-label="Uniones">
        <header className="qb-block-head">
          <h3>Uniones <small>{model.links.length}</small></h3>
          <button type="button" className="button form-secondary compact-button" disabled={model.sources.length < 2} onClick={addLink}>+ Agregar unión</button>
        </header>
        {model.links.length === 0 && <p className="panel-empty">{model.sources.length < 2 ? 'Agrega al menos dos fuentes para unirlas.' : 'Agrega una unión o aplica una de las sugerencias.'}</p>}
        <ol className="qb-join-rows">
          {model.links.map((link) => {
            const left = byId(link.from.source);
            const right = byId(link.to.source);
            const compat = joinCompatibility(fieldType(left, link.from.field), fieldType(right, link.to.field));
            return (
              <li key={link.id} className="qb-join-row" data-compat={compat}>
                <div className="qb-join-side">
                  <select className="form-input" aria-label="Fuente izquierda" value={link.from.source} onChange={({ target: { value } }) => setLink(link.id, (item) => ({ ...item, from: { source: value, field: byId(value)?.fields[0]?.name ?? '' } }))}>
                    {model.sources.filter((source) => source.id !== link.to.source).map((source) => <option key={source.id} value={source.id}>{source.alias}</option>)}
                  </select>
                  <select className="form-input" aria-label="Campo izquierdo" value={link.from.field} onChange={({ target: { value } }) => setLink(link.id, (item) => ({ ...item, from: { ...item.from, field: value } }))}>
                    {(left?.fields ?? []).map((field) => <option key={field.name} value={field.name}>{field.name} · {field.type}</option>)}
                  </select>
                </div>
                <select className="form-input qb-join-type" aria-label="Tipo de unión" value={link.type} onChange={({ target: { value } }) => setLink(link.id, (item) => ({ ...item, type: value as JoinType }))}>
                  {(Object.keys(JOIN_LABELS) as JoinType[]).map((type) => <option key={type} value={type}>{JOIN_LABELS[type]}</option>)}
                </select>
                <div className="qb-join-side">
                  <select className="form-input" aria-label="Fuente derecha" value={link.to.source} onChange={({ target: { value } }) => setLink(link.id, (item) => ({ ...item, to: { source: value, field: byId(value)?.fields[0]?.name ?? '' } }))}>
                    {model.sources.filter((source) => source.id !== link.from.source).map((source) => <option key={source.id} value={source.id}>{source.alias}</option>)}
                  </select>
                  <select className="form-input" aria-label="Campo derecho" value={link.to.field} onChange={({ target: { value } }) => setLink(link.id, (item) => ({ ...item, to: { ...item.to, field: value } }))}>
                    {(right?.fields ?? []).map((field) => <option key={field.name} value={field.name}>{field.name} · {field.type}</option>)}
                  </select>
                </div>
                <span className="qb-join-compat" title={compat === 'ok' ? 'Tipos compatibles' : compat === 'warning' ? 'Tipos distintos: puede no coincidir' : 'Tipos incompatibles'}>
                  {compat === 'ok' ? '✓' : '!'}
                </span>
                <button type="button" className="shell-icon-button" aria-label="Quitar unión" onClick={() => update((current) => ({ ...current, links: current.links.filter((item) => item.id !== link.id) }))}>×</button>
              </li>
            );
          })}
        </ol>
        {relations.length > 0 && (
          <p className="qb-plan" aria-label="Orden del cruce">
            <Icon name="join" size={13} />
            {order[0]?.alias}
            {relations.map(({ right, links }) => <span key={right.id}> → <strong>{right.alias}</strong> <small>({links.length > 1 ? `${links.length} llaves` : links[0].type})</small></span>)}
            {disconnected.length > 0 && <span className="qb-warn"> · sin unir: {disconnected.map((source) => source.alias).join(', ')}</span>}
          </p>
        )}
      </section>

      <section className="qb-block qb-suggest" aria-label="Uniones detectadas">
        <header className="qb-block-head">
          <h3><Icon name="spark" size={14} /> Uniones detectadas <small>{suggestions.length}</small></h3>
          {suggestions.length > 1 && <button type="button" className="row-action" onClick={applyAll}>Aplicar todas</button>}
        </header>
        {suggestions.length === 0 ? (
          <p className="field-help">{model.sources.length < 2 ? 'Cuando haya dos o más fuentes, aquí aparecerán los campos que se pueden cruzar.' : 'No hay más uniones probables entre las fuentes sin unir. Puedes agregar una manualmente.'}</p>
        ) : (
          <ul className="qb-suggest-list">
            {suggestions.map((suggestion) => {
              const left = byId(suggestion.link.from.source);
              const right = byId(suggestion.link.to.source);
              const pct = Math.round(suggestion.score * 100);
              return (
                <li key={suggestion.link.id}>
                  <div className="qb-suggest-main">
                    <strong>{left?.alias}.{suggestion.link.from.field} = {right?.alias}.{suggestion.link.to.field}</strong>
                    <span className="qb-confidence" data-level={pct >= 75 ? 'high' : pct >= 50 ? 'mid' : 'low'} title="Confianza de la detección">
                      <i style={{ width: `${pct}%` }} />{pct}%
                    </span>
                  </div>
                  <ul className="qb-reasons">{suggestion.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                  <button type="button" className="button form-secondary compact-button" onClick={() => applySuggestion(suggestion)}>Aplicar</button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
