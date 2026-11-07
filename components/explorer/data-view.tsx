'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ENGINES } from '@/components/connections/engines';
import { DateRangeFilter, dateColumns, describeDateFilter, type DateFilter } from '@/components/explorer/date-range-filter';
import { objectLabel, type CatalogObject, type ExplorerTarget } from '@/components/explorer/explorer-tree';
import { ColumnStats } from '@/components/explorer/column-stats';
import { ColumnManager, mergeColumns, type ColumnSetting } from '@/components/results/column-manager';
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
  /** Cómo se combinan los filtros: todos (Y) o cualquiera (O). */
  const [logic, setLogic] = useState<'AND' | 'OR'>('AND');
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(null);
  const [columnSettings, setColumnSettings] = useState<ColumnSetting[]>([]);
  const [showColumns, setShowColumns] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; rowIndex: number; column: string } | null>(null);
  const [statsColumn, setStatsColumn] = useState<string | null>(null);
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
              ...(filters.length ? { filtros: JSON.stringify(logic === 'OR' && filters.length > 1 ? [{ logica: 'OR', filtros: filters }] : filters) } : {}),
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
  }, [call, connection.id, object.name, object.schema, pageSize, cursor, filters, logic]);

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

  const columns = useMemo<string[]>(() => {
    const keys = page?.orden ?? [];
    const all = [...new Set((page?.rows ?? []).flatMap((row) => Object.keys(row)))];
    const internal = all.filter((column) => isInternal(column) && !keys.includes(column));
    const regular = all.filter((column) => !isInternal(column) && !keys.includes(column));
    return [...keys, ...regular, ...internal];
  }, [page]);

  useEffect(() => {
    if (columns.length) setColumnSettings((current) => mergeColumns(current, columns));
  }, [columns]);

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
  const visibleColumns = columnSettings.length ? columnSettings.filter((item) => item.visible).map((item) => item.name) : columns;
  // Orden por columna sobre la página cargada (el cursor del servidor sigue el orden de la llave).
  const displayRows = rows.map((row, index) => ({ row, index }));
  if (sort) {
    const sign = sort.direction === 'asc' ? 1 : -1;
    displayRows.sort((a, b) => {
      const x = a.row[sort.column];
      const y = b.row[sort.column];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return typeof x === 'number' && typeof y === 'number' ? sign * (x - y) : sign * String(cellText(x)).localeCompare(cellText(y), 'es', { numeric: true });
    });
  }
  const selected = selectedRow !== null ? rows[selectedRow] : null;

  function quickFilter(column: string, operador: string, value: unknown) {
    setMenu(null);
    setStatsColumn(null);
    const valor = operador === 'isNull' ? true : value;
    changeFilters([...filters, { campo: column, operador, valor }]);
  }

  function downloadPageCsv() {
    const escape = (value: unknown) => {
      let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [visibleColumns.map(escape).join(','), ...displayRows.map(({ row }) => visibleColumns.map((column) => escape(row[column])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${objectLabel(object)}-pagina-${cursors.length}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
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
          <button className="button form-secondary compact-button" type="button" aria-pressed={showColumns} onClick={() => setShowColumns((value) => !value)}><Icon name="table" size={13} />Columnas {visibleColumns.length}/{columns.length}</button>
          <button className="button form-secondary compact-button" type="button" disabled={rows.length === 0} onClick={downloadPageCsv}><Icon name="arrow-up-right" size={13} />CSV</button>
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
        {filters.length > 1 && (
          <div className="segmented logic-toggle" role="group" aria-label="Cómo combinar los filtros">
            <button type="button" aria-pressed={logic === 'AND'} onClick={() => { setLogic('AND'); setCursors([undefined]); }} title="Deben cumplirse todos">Todos (Y)</button>
            <button type="button" aria-pressed={logic === 'OR'} onClick={() => { setLogic('OR'); setCursors([undefined]); }} title="Basta con que se cumpla uno">Cualquiera (O)</button>
          </div>
        )}
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

      {showColumns && columnSettings.length > 0 && (
        <div className="explorer-columns"><ColumnManager columns={columnSettings} onChange={setColumnSettings} /></div>
      )}

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
                  {visibleColumns.map((column) => {
                    const direction = sort?.column === column ? sort.direction : null;
                    return (
                      <th key={column} data-key={page?.orden.includes(column) || undefined} title={column} aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}>
                        <span className="th-content">
                          <button type="button" className="th-sort" onClick={() => setSort((current) => (current?.column !== column ? { column, direction: 'asc' } : current.direction === 'asc' ? { column, direction: 'desc' } : null))}>
                            {page?.orden.includes(column) && <Icon name="lock" size={11} />}{column}
                            {direction && <span aria-hidden="true">{direction === 'asc' ? ' ↑' : ' ↓'}</span>}
                          </button>
                          <button type="button" className="th-stats" aria-label={`Estadísticas de ${column}`} title="Estadísticas de la columna" onClick={() => setStatsColumn(column)}><Icon name="activity" size={11} /></button>
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {displayRows.map(({ row, index: rowIndex }) => (
                  <tr key={rowIndex} aria-selected={selectedRow === rowIndex} onClick={() => setSelectedRow(rowIndex)}>
                    <td className="results-index">{(pageNumber - 1) * pageSize + rowIndex + 1}</td>
                    {visibleColumns.map((column) => {
                      const value = row[column];
                      const isEditing = editing?.rowIndex === rowIndex && editing.column === column;
                      return (
                        <td
                          key={column}
                          data-type={cellType(value)}
                          data-saved={savedCell === `${rowIndex}:${column}` || undefined}
                          title={editable(row, column) ? `${cellText(value)} · doble clic para editar` : cellText(value)}
                          onDoubleClick={() => editable(row, column) && setEditing({ rowIndex, column, draft: value === null || value === undefined ? '' : String(value) })}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setMenu({ x: event.clientX, y: event.clientY, rowIndex, column });
                          }}
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

      {menu && (() => {
        const value = rows[menu.rowIndex]?.[menu.column];
        const scalar = isScalar(value ?? null);
        return (
          <div className="context-backdrop" onClick={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }}>
            <div className="context-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 260) }} onClick={(event) => event.stopPropagation()}>
              <p className="context-title">{menu.column}: <code>{cellText(value).slice(0, 40)}</code></p>
              {scalar && value !== null && value !== undefined && <>
                <button type="button" role="menuitem" onClick={() => quickFilter(menu.column, 'eq', value)}>Filtrar = este valor</button>
                <button type="button" role="menuitem" onClick={() => quickFilter(menu.column, 'neq', value)}>Excluir este valor</button>
                {typeof value === 'number' && <>
                  <button type="button" role="menuitem" onClick={() => quickFilter(menu.column, 'gte', value)}>Mayor o igual</button>
                  <button type="button" role="menuitem" onClick={() => quickFilter(menu.column, 'lte', value)}>Menor o igual</button>
                </>}
              </>}
              {(value === null || value === undefined) && <button type="button" role="menuitem" onClick={() => quickFilter(menu.column, 'isNull', true)}>Solo los vacíos</button>}
              <button type="button" role="menuitem" onClick={() => { void navigator.clipboard.writeText(cellText(value)); setMenu(null); }}>Copiar valor</button>
              <button type="button" role="menuitem" onClick={() => { setSort({ column: menu.column, direction: 'asc' }); setMenu(null); }}>Ordenar ascendente</button>
              <button type="button" role="menuitem" onClick={() => { setStatsColumn(menu.column); setMenu(null); }}>Estadísticas de la columna</button>
              <button type="button" role="menuitem" onClick={() => { setColumnSettings((current) => current.map((item) => (item.name === menu.column ? { ...item, visible: false } : item))); setMenu(null); }}>Ocultar columna</button>
            </div>
          </div>
        );
      })()}
      {statsColumn && <ColumnStats column={statsColumn} rows={rows} onClose={() => setStatsColumn(null)} onFilter={(value) => quickFilter(statsColumn, value === null || value === undefined ? 'isNull' : 'eq', value)} />}

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
