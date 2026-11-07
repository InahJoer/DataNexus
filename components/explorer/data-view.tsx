'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ENGINES } from '@/components/connections/engines';
import { DateRangeFilter, dateColumns, describeDateFilter, type DateFilter } from '@/components/explorer/date-range-filter';
import { objectLabel, type CatalogObject, type ExplorerTarget } from '@/components/explorer/explorer-tree';
import { Icon } from '@/components/icons';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/permissions';

type Row = Record<string, unknown>;
type Scalar = string | number | boolean | null;
type Filter = { campo: string; operador: string; valor: unknown };
type Page = { rows: Row[]; orden: string[]; nextCursor: string | null };
type Editing = { rowIndex: number; column: string; draft: string } | null;

const PAGE_SIZES = [25, 50, 100, 250];
/** kind: cuántos valores pide el operador (uno, dos para "entre", una lista separada por comas o ninguno). */
const OPERATORS: { value: string; label: string; kind: 'value' | 'range' | 'list' | 'none' }[] = [
  { value: 'eq', label: '=', kind: 'value' },
  { value: 'neq', label: '≠', kind: 'value' },
  { value: 'gt', label: '>', kind: 'value' },
  { value: 'gte', label: '≥', kind: 'value' },
  { value: 'lt', label: '<', kind: 'value' },
  { value: 'lte', label: '≤', kind: 'value' },
  { value: 'between', label: 'entre', kind: 'range' },
  { value: 'in', label: 'está en (lista)', kind: 'list' },
  { value: 'not-in', label: 'no está en (lista)', kind: 'list' },
  { value: 'contains', label: 'contiene', kind: 'value' },
  { value: 'startsWith', label: 'empieza con', kind: 'value' },
  { value: 'isNull', label: 'está vacío', kind: 'none' },
  { value: 'notNull', label: 'no está vacío', kind: 'none' },
];

/** Texto del chip de un filtro. */
function describeFilter(filter: Filter) {
  const date = describeDateFilter(filter);
  if (date) return `${filter.campo}: ${date}`;
  if (filter.operador === 'isNull') return `${filter.campo} ${filter.valor ? 'está vacío' : 'no está vacío'}`;
  const label = OPERATORS.find((operator) => operator.value === filter.operador)?.label ?? filter.operador;
  if (Array.isArray(filter.valor)) {
    return filter.operador === 'between'
      ? `${filter.campo} entre ${JSON.stringify(filter.valor[0])} y ${JSON.stringify(filter.valor[1])}`
      : `${filter.campo} ${label} ${filter.valor.map((value) => JSON.stringify(value)).join(', ')}`;
  }
  return `${filter.campo} ${label} ${JSON.stringify(filter.valor)}`;
}

const isScalar = (value: unknown): value is Scalar => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const isInternal = (column: string) => column.startsWith('__');

/** "42" → 42, "true" → true, "null" → null; el resto queda como texto (entre comillas fuerza texto). */
function parseInput(raw: string): Scalar {
  const text = raw.trim();
  if (/^".*"$/.test(text)) return text.slice(1, -1);
  if (text === 'true' || text === 'false') return text === 'true';
  if (text === 'null') return null;
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text);
  return raw;
}

/** El valor nuevo conserva el tipo del anterior: si era número, debe seguir siendo número. */
function coerceLike(previous: Scalar, raw: string): Scalar | Error {
  if (typeof previous === 'number') {
    const value = Number(raw);
    return raw.trim() === '' || Number.isNaN(value) ? new Error('Escribe un número') : value;
  }
  if (typeof previous === 'boolean') {
    if (raw !== 'true' && raw !== 'false') return new Error('Escribe true o false');
    return raw === 'true';
  }
  if (previous === null) return parseInput(raw);
  return raw;
}

function cellText(value: unknown) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.length}] ${JSON.stringify(value)}`;
  if (typeof value === 'object') return `{${Object.keys(value).length}} ${JSON.stringify(value)}`;
  return String(value);
}

function cellType(value: unknown) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

type DataViewProps = Readonly<{
  target: ExplorerTarget;
  /** Subcolecciones conocidas de esta colección (Firestore): se ofrecen en el panel del documento. */
  subcollections: string[];
  onOpen: (object: CatalogObject) => void;
}>;

/** Vista de datos de una tabla o colección: grid editable, filtros, paginación por cursor y panel de documento. */
export function DataView({ target, subcollections, onOpen }: DataViewProps) {
  const call = useApiCall();
  const { session } = useAuth();
  const canEdit = hasPermission(session?.user.role, 'MODIFY_RECORDS');
  const { connection, object } = target;
  const isSql = ENGINES[connection.tipoMotor].kind === 'sql';

  const [pageSize, setPageSize] = useState(50);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [draftFilter, setDraftFilter] = useState({ campo: '', operador: 'eq', valor: '', valor2: '' });
  const [filterError, setFilterError] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState<Page | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'table' | 'json'>('table');
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [savedCell, setSavedCell] = useState<string | null>(null);
  const requestId = useRef(0);
  const cursor = cursors.at(-1);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await call((api) =>
        api.GET('/engine/connections/{connectionId}/data', {
          params: {
            path: { connectionId: connection.id },
            query: {
              entidad: object.name,
              ...(object.schema ? { esquema: object.schema } : {}),
              limite: pageSize,
              ...(cursor ? { cursor } : {}),
              ...(filters.length ? { filtros: JSON.stringify(filters) } : {}),
            },
          },
        }),
      );
      if (id !== requestId.current) return;
      if (!result.response.ok || !result.data) {
        setError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      setPage({ rows: result.data.data, orden: result.data.orden, nextCursor: result.data.nextCursor });
    } catch {
      if (id === requestId.current) setError(NETWORK_ERROR_MESSAGE);
    } finally {
      if (id === requestId.current) setIsLoading(false);
    }
  }, [call, connection.id, object.name, object.schema, pageSize, cursor, filters]);

  // Al cambiar de tabla o colección se empieza desde la primera página y sin filtros.
  useEffect(() => {
    setCursors([undefined]);
    setFilters([]);
    setSelectedRow(null);
    setEditing(null);
    setPage(null);
  }, [connection.id, object.name, object.schema]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = useMemo(() => {
    const keys = page?.orden ?? [];
    const all = [...new Set((page?.rows ?? []).flatMap((row) => Object.keys(row)))];
    const internal = all.filter((column) => isInternal(column) && !keys.includes(column));
    const regular = all.filter((column) => !isInternal(column) && !keys.includes(column));
    return [...keys, ...regular, ...internal];
  }, [page]);

  function changeFilters(next: Filter[]) {
    setFilters(next);
    setCursors([undefined]);
    setSelectedRow(null);
  }

  function addFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { campo, operador } = draftFilter;
    if (!campo) return;
    const kind = OPERATORS.find((item) => item.value === operador)?.kind ?? 'value';
    let filter: Filter;
    if (kind === 'none') {
      filter = { campo, operador: 'isNull', valor: operador === 'isNull' };
    } else if (kind === 'range') {
      const [min, max] = [parseInput(draftFilter.valor), parseInput(draftFilter.valor2)];
      if (typeof min !== typeof max || (typeof min !== 'number' && typeof min !== 'string')) {
        setFilterError('"entre" necesita dos números o dos textos del mismo tipo');
        return;
      }
      filter = { campo, operador, valor: [min, max] };
    } else if (kind === 'list') {
      const values = draftFilter.valor.split(',').map((value) => parseInput(value.trim())).filter((value) => value !== '');
      if (values.length === 0) {
        setFilterError('Escribe uno o más valores separados por comas');
        return;
      }
      filter = { campo, operador, valor: values };
    } else {
      filter = { campo, operador, valor: ['contains', 'startsWith'].includes(operador) ? draftFilter.valor : parseInput(draftFilter.valor) };
    }
    setFilterError(null);
    changeFilters([...filters, filter]);
    setDraftFilter((current) => ({ ...current, valor: '', valor2: '' }));
  }

  /** Un rango de fechas nuevo reemplaza al anterior del mismo campo. */
  function applyDateFilter(filter: DateFilter) {
    changeFilters([...filters.filter((current) => !(current.campo === filter.campo && describeDateFilter(current))), filter]);
  }

  function primaryKeyOf(row: Row): string | Record<string, Scalar> | null {
    const keys = page?.orden ?? [];
    if (keys.length === 0 || keys.some((key) => !isScalar(row[key]))) return null;
    if (isSql) return Object.fromEntries(keys.map((key) => [key, row[key] as Scalar]));
    const value = row[keys[0]];
    return typeof value === 'string' ? value : null;
  }

  const editable = (row: Row, column: string) =>
    canEdit && !(page?.orden ?? []).includes(column) && !isInternal(column) && isScalar(row[column] ?? null) && primaryKeyOf(row) !== null;

  async function saveEdit() {
    if (!editing || !page) return;
    const row = page.rows[editing.rowIndex];
    const previous = (row[editing.column] ?? null) as Scalar;
    const next = coerceLike(previous, editing.draft);
    if (next instanceof Error) {
      setEditError(next.message);
      return;
    }
    if (next === previous) {
      setEditing(null);
      return;
    }
    const key = primaryKeyOf(row);
    if (key === null) return;
    try {
      const result = await call((api) =>
        api.PATCH('/engine/records', {
          body: {
            conexionId: connection.id,
            entidad: object.name,
            ...(object.schema ? { esquema: object.schema } : {}),
            llavePrimaria: key,
            campo: editing.column,
            valorAnterior: previous,
            valorNuevo: next,
          },
        }),
      );
      if (!result.response.ok) {
        setEditError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      const rows = page.rows.map((current, index) => (index === editing.rowIndex ? { ...current, [editing.column]: next } : current));
      setPage({ ...page, rows });
      setSavedCell(`${editing.rowIndex}:${editing.column}`);
      window.setTimeout(() => setSavedCell(null), 1500);
      setEditing(null);
      setEditError(null);
    } catch {
      setEditError(NETWORK_ERROR_MESSAGE);
    }
  }

  function onEditKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') void saveEdit();
    if (event.key === 'Escape') {
      setEditing(null);
      setEditError(null);
    }
  }

  const rows = page?.rows ?? [];
  const selected = selectedRow !== null ? rows[selectedRow] : null;
  const pageNumber = cursors.length;
  const isGroup = object.name.includes('/*/');
  const selectedDocId = selected && typeof selected.__documentId === 'string' ? selected.__documentId : null;

  return (
    <section className="explorer-data" aria-label={`Datos de ${objectLabel(object)}`}>
      <header className="explorer-toolbar">
        <div className="explorer-title">
          <span className="engine-badge" data-engine={connection.tipoMotor}>{ENGINES[connection.tipoMotor].short}</span>
          <div>
            <h2>{objectLabel(object)}</h2>
            <p>{connection.nombre ?? connection.dbName} · {isGroup ? `todas las subcolecciones de ${object.name.split('/*/')[0]}` : object.type === 'COLLECTION' ? 'colección' : object.type === 'VIEW' ? 'vista' : 'tabla'}</p>
          </div>
        </div>
        <div className="explorer-actions">
          <div className="segmented" role="group" aria-label="Vista">
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}><Icon name="table" size={13} />Tabla</button>
            <button type="button" aria-pressed={view === 'json'} onClick={() => setView('json')}><Icon name="file" size={13} />JSON</button>
          </div>
          <select className="form-input compact-select" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setCursors([undefined]); }} aria-label="Filas por página">
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} filas</option>)}
          </select>
          <button className="shell-icon-button" type="button" onClick={() => void load()} aria-label="Recargar" disabled={isLoading}><Icon name="refresh" size={15} /></button>
        </div>
      </header>

      <form className="filter-bar" onSubmit={addFilter}>
        <Icon name="search" size={14} />
        <input className="form-input" list="explorer-columns" placeholder="Campo (ej. ciudad o direccion.pais)" value={draftFilter.campo} onChange={(event) => setDraftFilter({ ...draftFilter, campo: event.target.value })} aria-label="Campo a filtrar" />
        <datalist id="explorer-columns">{columns.filter((column) => !isInternal(column)).map((column) => <option key={column} value={column} />)}</datalist>
        <select className="form-input" value={draftFilter.operador} onChange={(event) => setDraftFilter({ ...draftFilter, operador: event.target.value })} aria-label="Operador">
          {OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
        </select>
        {(() => {
          const kind = OPERATORS.find((operator) => operator.value === draftFilter.operador)?.kind;
          if (kind === 'none') return null;
          return (
            <>
              <input
                className="form-input"
                placeholder={kind === 'list' ? 'valor1, valor2, …' : kind === 'range' ? 'Desde' : 'Valor'}
                value={draftFilter.valor}
                onChange={(event) => setDraftFilter({ ...draftFilter, valor: event.target.value })}
                aria-label={kind === 'range' ? 'Valor mínimo' : 'Valor del filtro'}
              />
              {kind === 'range' && (
                <input className="form-input" placeholder="Hasta" value={draftFilter.valor2} onChange={(event) => setDraftFilter({ ...draftFilter, valor2: event.target.value })} aria-label="Valor máximo" />
              )}
            </>
          );
        })()}
        <button className="button form-secondary" type="submit" disabled={!draftFilter.campo}>Filtrar</button>
        {filters.map((filter, index) => (
          <span className="filter-chip" key={`${filter.campo}-${index}`}>
            {describeFilter(filter)}
            <button type="button" aria-label={`Quitar filtro ${filter.campo}`} onClick={() => changeFilters(filters.filter((_, i) => i !== index))}><Icon name="close" size={11} /></button>
          </span>
        ))}
      </form>

      <DateRangeFilter suggested={dateColumns(rows, columns)} onApply={applyDateFilter} />
      {filterError && <p className="form-error explorer-error" role="alert">{filterError}</p>}
      {error && <p className="form-error explorer-error" role="alert">{error}</p>}
      {editError && <p className="form-error explorer-error" role="alert">No se guardó el cambio: {editError}</p>}

      <div className="explorer-body" data-with-panel={selected !== null}>
        <div className="explorer-grid-wrap">
          {!page && isLoading ? (
            <p className="page-message">Cargando datos…</p>
          ) : rows.length === 0 ? (
            <p className="page-message">{filters.length ? 'Ningún registro cumple los filtros.' : 'Esta tabla o colección no tiene registros.'}</p>
          ) : view === 'json' ? (
            <pre className="json-view">{JSON.stringify(rows, null, 2)}</pre>
          ) : (
            <table className="data-table explorer-grid" aria-busy={isLoading}>
              <thead>
                <tr>
                  <th className="results-index">#</th>
                  {columns.map((column) => (
                    <th key={column} data-key={page?.orden.includes(column) || undefined} title={column}>
                      {page?.orden.includes(column) && <Icon name="lock" size={11} />}{column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex} aria-selected={selectedRow === rowIndex} onClick={() => setSelectedRow(rowIndex)}>
                    <td className="results-index">{(pageNumber - 1) * pageSize + rowIndex + 1}</td>
                    {columns.map((column) => {
                      const value = row[column];
                      const isEditing = editing?.rowIndex === rowIndex && editing.column === column;
                      return (
                        <td
                          key={column}
                          data-type={cellType(value)}
                          data-saved={savedCell === `${rowIndex}:${column}` || undefined}
                          title={editable(row, column) ? `${cellText(value)} · doble clic para editar` : cellText(value)}
                          onDoubleClick={() => editable(row, column) && setEditing({ rowIndex, column, draft: value === null || value === undefined ? '' : String(value) })}
                        >
                          {isEditing ? (
                            <input
                              className="cell-editor"
                              autoFocus
                              value={editing.draft}
                              onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
                              onKeyDown={onEditKey}
                              onBlur={() => void saveEdit()}
                              aria-label={`Editar ${column}`}
                            />
                          ) : cellText(value)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selected && (
          <aside className="document-panel" aria-label="Documento seleccionado">
            <header>
              <strong>{selectedDocId ?? (selected && (page?.orden ?? []).map((key) => String(selected[key])).join(' · ')) ?? 'Registro'}</strong>
              <button className="shell-icon-button" type="button" aria-label="Cerrar documento" onClick={() => setSelectedRow(null)}><Icon name="close" size={14} /></button>
            </header>
            {selectedDocId && !isGroup && subcollections.length > 0 && (
              <div className="document-subcollections">
                <span>Subcolecciones</span>
                {subcollections.map((sub) => (
                  <button key={sub} type="button" className="row-action" onClick={() => onOpen({ name: `${object.name}/${selectedDocId}/${sub}`, type: 'COLLECTION' })}>
                    <Icon name="folder" size={12} />{sub}
                  </button>
                ))}
              </div>
            )}
            <pre className="json-view">{JSON.stringify(selected, null, 2)}</pre>
          </aside>
        )}
      </div>

      <footer className="explorer-footer">
        <span>{rows.length} registros en la página {pageNumber}{canEdit ? ' · doble clic en una celda para editarla' : ''}</span>
        <div>
          <button className="row-action" type="button" disabled={pageNumber === 1 || isLoading} onClick={() => setCursors((current) => current.slice(0, -1))}>Anterior</button>
          <button className="row-action" type="button" disabled={!page?.nextCursor || isLoading} onClick={() => page?.nextCursor && setCursors((current) => [...current, page.nextCursor ?? undefined])}>Siguiente</button>
        </div>
      </footer>
    </section>
  );
}
