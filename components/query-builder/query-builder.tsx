'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@/components/app-shell/workspace-context';
import { ENGINES, type Connection } from '@/components/connections/engines';
import { objectLabel, type CatalogObject } from '@/components/explorer/explorer-tree';
import { Icon } from '@/components/icons';
import { SaveQueryModal } from '@/components/joins/save-query-modal';
import { DRAG_MIME, QueryCanvas } from '@/components/query-builder/canvas';
import {
  CARD_WIDTH,
  EMPTY_MODEL,
  aliasFor,
  fromDefinition,
  inferFields,
  plan,
  suggestLinks,
  toPayload,
  toSql,
  uid,
  type JoinPayload,
  type QbLink,
  type QbModel,
} from '@/components/query-builder/model';
import { OutputPanel } from '@/components/query-builder/output-panel';
import { QuickChart } from '@/components/query-builder/quick-chart';
import { ExportModal } from '@/components/results/export-modal';
import { ResultsGrid } from '@/components/results/results-grid';
import type { ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useApiQuery } from '@/lib/api/use-api-query';
import type { components } from '@/lib/api/schema';

type JoinResult = components['schemas']['PaginatedCrossJoinResultDto'];
type SavedQuery = components['schemas']['SavedQueryResponseDto'];
type DragObject = { connectionId: string; name: string; schema?: string };
type Tab = 'canvas' | 'results' | 'saved';

const DRAFT_KEY = 'datanexus:query-builder';
const SENSITIVE = /(email|correo|telefono|phone|movil|cedula|dni|ssn|password|contrasena|tarjeta|card|iban|cuenta)/i;
const PAGE_SIZE = 50;

function useHistory(initial: QbModel) {
  const [state, setState] = useState({ past: [] as QbModel[], present: initial, future: [] as QbModel[] });
  const set = useCallback((recipe: (model: QbModel) => QbModel, commit = true) => {
    setState((current) => {
      const next = recipe(current.present);
      if (next === current.present) return current;
      return commit ? { past: [...current.past.slice(-49), current.present], present: next, future: [] } : { ...current, present: next };
    });
  }, []);
  const reset = useCallback((model: QbModel) => setState({ past: [], present: model, future: [] }), []);
  const undo = useCallback(() => setState((current) => (current.past.length ? { past: current.past.slice(0, -1), present: current.past.at(-1)!, future: [current.present, ...current.future] } : current)), []);
  const redo = useCallback(() => setState((current) => (current.future.length ? { past: [...current.past, current.present], present: current.future[0], future: current.future.slice(1) } : current)), []);
  return { model: state.present, set, reset, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

/**
 * Query Builder visual (#45): lienzo con tarjetas de tablas, colecciones y subcolecciones de cualquier conexión,
 * uniones arrastrando entre campos, sugerencias automáticas, filtros, columnas, agrupación, orden, SQL equivalente,
 * vista previa en vivo, resultados con gráfico, exportación y consultas guardadas.
 */
export function QueryBuilder() {
  const call = useApiCall();
  const { workspace } = useWorkspace();
  const connections = useApiQuery(useCallback((api: ApiClient) => api.GET('/connections'), []));
  const saved = useApiQuery(useCallback((api: ApiClient) => api.GET('/queries'), []));
  const history = useHistory(EMPTY_MODEL);
  const { model } = history;
  const [tab, setTab] = useState<Tab>('canvas');
  const [panelTab, setPanelTab] = useState<'source' | 'columns' | 'group' | 'sort'>('source');
  const [selected, setSelected] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, CatalogObject[] | 'loading'>>({});
  const [openConnections, setOpenConnections] = useState<Record<string, boolean>>({});
  const [paletteFilter, setPaletteFilter] = useState('');
  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; total: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [resultPayload, setResultPayload] = useState<JoinPayload | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [dialog, setDialog] = useState<'save' | 'export' | null>(null);
  const [current, setCurrent] = useState<{ id: string; nombre: string; savedAt: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const restored = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const connectionById = useCallback((id: string) => (connections.data ?? []).find((item) => item.id === id), [connections.data]);

  // Borrador automático en el dispositivo (se recupera al volver).
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) history.reset(JSON.parse(raw) as QbModel);
    } catch {
      // Borrador dañado: se empieza vacío.
    }
  }, [history]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(model));
      } catch {
        // Sin almacenamiento no hay borrador.
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [model]);

  // Atajos: Ctrl+Z / Ctrl+Y.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || (event.target as HTMLElement).closest('input, textarea, select')) return;
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) history.redo(); else history.undo(); }
      if (event.key.toLowerCase() === 'y') { event.preventDefault(); history.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history]);

  async function loadCatalog(connectionId: string) {
    if (catalogs[connectionId]) return;
    setCatalogs((value) => ({ ...value, [connectionId]: 'loading' }));
    const response = await call((api) => api.GET('/engine/connections/{connectionId}/schema', { params: { path: { connectionId } } })).catch(() => null);
    const objects = response?.data?.objects;
    setCatalogs((value) => ({ ...value, [connectionId]: objects ?? [] }));
  }

  /** Campos con su tipo: nombres del esquema más una muestra de 25 filas para inferir tipos y campos anidados. */
  async function loadFields(connectionId: string, name: string, schema?: string) {
    const [fields, sample] = await Promise.all([
      call((api) => api.GET('/engine/connections/{connectionId}/schema/fields', { params: { path: { connectionId }, query: { objectName: name, ...(schema ? { schema } : {}) } } })).catch(() => null),
      call((api) => api.GET('/engine/connections/{connectionId}/data', { params: { path: { connectionId }, query: { entidad: name, ...(schema ? { esquema: schema } : {}), limite: 25 } } })).catch(() => null),
    ]);
    return inferFields(fields?.data?.fields ?? [], sample?.data?.data ?? []);
  }

  async function addSource(object: DragObject, at?: { x: number; y: number }) {
    const connection = connectionById(object.connectionId);
    if (!connection) return;
    const id = uid('src');
    const alias = aliasFor(object.name, model.sources.map((source) => source.alias));
    const position = at ?? { x: 40 + (model.sources.length % 3) * (CARD_WIDTH + 90), y: 70 + Math.floor(model.sources.length / 3) * 380 };
    history.set((value) => ({
      ...value,
      columns: [],
      sources: [...value.sources, { id, alias, connectionId: connection.id, connectionName: connection.nombre ?? connection.dbName, engine: connection.tipoMotor, entity: object.name, schema: object.schema, fields: [], x: position.x, y: position.y, filters: [], logic: 'AND' }],
    }));
    setSelected(id);
    const fields = await loadFields(connection.id, object.name, object.schema);
    history.set((value) => ({ ...value, sources: value.sources.map((source) => (source.id === id ? { ...source, fields } : source)) }), false);
  }

  /** Abre una consulta guardada o importada: carga los campos de cada fuente y reconstruye el lienzo. */
  async function openDefinition(definition: JoinPayload, meta: { id: string; nombre: string } | null) {
    const raw = definition as unknown as { fuentes?: { alias: string; conexionId: string; entidad: string; esquema?: string }[] };
    if (!raw.fuentes?.length) {
      setNotice('Esta consulta usa el formato antiguo de 2 fuentes; ábrela desde el editor anterior o vuelve a crearla en el lienzo.');
      return;
    }
    setNotice('Abriendo consulta…');
    const base = await Promise.all(raw.fuentes.map(async (source) => {
      const connection = connectionById(source.conexionId);
      return {
        id: uid('src'),
        alias: source.alias,
        connectionId: source.conexionId,
        connectionName: connection?.nombre ?? connection?.dbName ?? 'Conexión no disponible',
        engine: connection?.tipoMotor ?? 'POSTGRESQL',
        entity: source.entidad,
        schema: source.esquema,
        fields: await loadFields(source.conexionId, source.entidad, source.esquema),
      };
    }));
    history.reset(fromDefinition(definition, base));
    setCurrent(meta ? { ...meta, savedAt: null } : null);
    setResult(null);
    setTab('canvas');
    setNotice(meta ? `Consulta "${meta.nombre}" abierta.` : 'Consulta importada.');
  }

  // Columnas que producirá el cruce: un nombre repetido entre fuentes se califica con el alias (como el motor).
  const outputColumns = useMemo(() => {
    const { order } = plan(model);
    const sources = order.length ? order : model.sources;
    const count = new Map<string, number>();
    for (const source of sources) for (const field of source.fields) count.set(field.name, (count.get(field.name) ?? 0) + 1);
    const sensitiveConfigured = new Set((workspace.data?.configuracion?.camposSensibles ?? []).map((field) => field.toLowerCase()));
    return sources.flatMap((source) => source.fields.map((field) => ({
      name: (count.get(field.name) ?? 0) > 1 ? `${source.alias}.${field.name}` : field.name,
      type: field.type,
      sensitive: SENSITIVE.test(field.name) || sensitiveConfigured.has(field.name.toLowerCase()),
    })));
  }, [model, workspace.data]);

  // Mantiene la lista de columnas configuradas al día con las fuentes (conserva orden, alias y visibilidad).
  useEffect(() => {
    if (!model.columns.length) return;
    const names = outputColumns.map((column) => column.name);
    const same = names.length === model.columns.length && model.columns.every((column) => names.includes(column.name));
    if (same) return;
    history.set((value) => ({
      ...value,
      columns: [...value.columns.filter((column) => names.includes(column.name)), ...names.filter((name) => !value.columns.some((column) => column.name === name)).map((name) => ({ name, visible: true, alias: '' }))],
    }), false);
  }, [outputColumns, model.columns, history]);

  const suggestions = useMemo(() => suggestLinks(model), [model]);
  const { disconnected } = plan(model);
  const payload = useMemo(() => toPayload(model), [model]);
  const sql = useMemo(() => toSql(model), [model]);

  // Vista previa en vivo (10 filas) cuando el cruce está completo; se pide 900 ms después del último cambio.
  const previewKey = payload ? JSON.stringify({ ...payload, lienzo: undefined }) : '';
  useEffect(() => {
    if (!payload) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      setIsPreviewing(true);
      try {
        const response = await call((api) => api.POST('/engine/join', { body: { ...payload, limit: 10, offset: 0 } }));
        if (!response.response.ok || !response.data) {
          setPreviewError(apiErrorMessage(response.error, response.response.status));
          setPreview(null);
        } else {
          setPreview({ rows: response.data.data, total: response.data.total });
          setPreviewError(null);
        }
      } catch {
        setPreviewError(NETWORK_ERROR_MESSAGE);
      } finally {
        setIsPreviewing(false);
      }
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  async function run(offset = 0) {
    if (!payload) return;
    setIsRunning(true);
    setRunError(null);
    try {
      const response = await call((api) => api.POST('/engine/join', { body: { ...payload, limit: PAGE_SIZE, offset } }));
      if (!response.response.ok || !response.data) {
        setRunError(apiErrorMessage(response.error, response.response.status));
        return;
      }
      setResult(response.data);
      setResultPayload(payload);
      setTab('results');
    } catch {
      setRunError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsRunning(false);
    }
  }

  async function saveChanges() {
    if (!current || !payload) return;
    const response = await call((api) => api.PATCH('/queries/{id}', { params: { path: { id: current.id } }, body: { definicion: payload } })).catch(() => null);
    if (response?.response.ok) {
      setCurrent({ ...current, savedAt: new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) });
      void saved.reload();
    } else {
      setNotice(response ? apiErrorMessage(response.error, response.response.status) : NETWORK_ERROR_MESSAGE);
    }
  }

  function exportJson() {
    if (!payload) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ tipo: 'datanexus-consulta', version: 1, nombre: current?.nombre ?? 'consulta', definicion: payload }, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(current?.nombre ?? 'consulta').replace(/[^\w-]+/g, '-')}.datanexus.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importJson(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as { definicion?: JoinPayload };
      if (!parsed.definicion) throw new Error('formato');
      await openDefinition(parsed.definicion, null);
    } catch {
      setNotice('El archivo no es una consulta de DataNexus válida.');
    }
  }

  function autoLayout() {
    const { order, disconnected: loose } = plan(model);
    const depth = new Map<string, number>();
    for (const source of order) {
      const link = model.links.find((item) => (item.to.source === source.id && depth.has(item.from.source)) || (item.from.source === source.id && depth.has(item.to.source)));
      const parent = link ? (link.to.source === source.id ? link.from.source : link.to.source) : null;
      depth.set(source.id, parent ? (depth.get(parent) ?? 0) + 1 : 0);
    }
    const rows = new Map<number, number>();
    history.set((value) => ({
      ...value,
      sources: value.sources.map((source) => {
        const column = depth.get(source.id) ?? (loose.includes(source) ? Math.max(0, ...depth.values()) + 1 : 0);
        const row = rows.get(column) ?? 0;
        rows.set(column, row + 1);
        return { ...source, x: 40 + column * (CARD_WIDTH + 110), y: 70 + row * 300 };
      }),
    }));
  }

  const selectedSource = model.sources.find((source) => source.id === selected) ?? null;
  const aggregated = model.groupBy.length > 0 || model.metrics.length > 0;
  const status = model.sources.length < 2
    ? 'Agrega al menos dos fuentes'
    : disconnected.length ? `Une ${disconnected.map((source) => source.alias).join(', ')} con otra fuente` : 'Listo para ejecutar';
  const term = paletteFilter.trim().toLowerCase();

  return (
    <div className="qb">
      <div className="qb-toolbar">
        <div className="segmented" role="tablist" aria-label="Vista">
          {([['canvas', 'Lienzo'], ['results', 'Resultados'], ['saved', 'Consultas guardadas']] as const).map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}{value === 'saved' && saved.data ? ` (${saved.data.length})` : ''}</button>
          ))}
        </div>
        <span className="qb-title">{current ? <><strong>{current.nombre}</strong>{current.savedAt && <small>Guardado a las {current.savedAt}</small>}</> : <small>Consulta sin guardar · borrador automático</small>}</span>
        <div className="qb-actions">
          <button type="button" className="shell-icon-button" aria-label="Deshacer (Ctrl+Z)" title="Deshacer (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}>↶</button>
          <button type="button" className="shell-icon-button" aria-label="Rehacer (Ctrl+Y)" title="Rehacer (Ctrl+Y)" disabled={!history.canRedo} onClick={history.redo}>↷</button>
          <button type="button" className="button form-secondary compact-button" onClick={() => { history.set(() => EMPTY_MODEL); setCurrent(null); setResult(null); }}>Nuevo</button>
          <button type="button" className="button form-secondary compact-button" onClick={() => fileInput.current?.click()}>Importar</button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importJson(file); event.target.value = ''; }} />
          <button type="button" className="button form-secondary compact-button" disabled={!payload} onClick={exportJson}>Exportar JSON</button>
          {current
            ? <button type="button" className="button form-secondary compact-button" disabled={!payload} onClick={() => void saveChanges()}><Icon name="file" size={13} />Guardar cambios</button>
            : <button type="button" className="button form-secondary compact-button" disabled={!payload} onClick={() => setDialog('save')}><Icon name="file" size={13} />Guardar</button>}
          <button type="button" className="button button--primary compact-button" disabled={!payload || isRunning} onClick={() => void run(0)}><Icon name="join" size={13} />{isRunning ? 'Ejecutando…' : 'Ejecutar'}</button>
        </div>
      </div>
      {notice && <p className="page-notice qb-notice" role="status">{notice} <button type="button" className="inline-link auth-link" onClick={() => setNotice(null)}>Cerrar</button></p>}
      {runError && <p className="form-error qb-notice" role="alert">{runError}</p>}

      {tab === 'canvas' && (
        <div className="qb-workspace">
          <aside className="qb-palette" aria-label="Fuentes disponibles">
            <label className="search-field"><Icon name="search" size={13} /><input type="search" placeholder="Buscar tabla o colección" value={paletteFilter} onChange={(event) => setPaletteFilter(event.target.value)} aria-label="Buscar fuentes" /></label>
            <p className="field-help">Arrastra al lienzo o haz clic para agregar.</p>
            <ul className="tree-root">
              {(connections.data ?? []).map((connection: Connection) => {
                const catalog = catalogs[connection.id];
                const open = openConnections[connection.id] || Boolean(term && Array.isArray(catalog));
                return (
                  <li key={connection.id}>
                    <button type="button" className="tree-connection" aria-expanded={open} onClick={() => { setOpenConnections((value) => ({ ...value, [connection.id]: !value[connection.id] })); void loadCatalog(connection.id); }}>
                      <Icon name="chevron-right" size={12} className={open ? 'tree-caret tree-caret--open' : 'tree-caret'} />
                      <span className="engine-badge" data-engine={connection.tipoMotor}>{ENGINES[connection.tipoMotor].short}</span>
                      <span className="tree-connection-name">{connection.nombre ?? connection.dbName}<small>{ENGINES[connection.tipoMotor].label}</small></span>
                    </button>
                    {open && (
                      <ul className="tree-children">
                        {catalog === 'loading' && <li className="tree-note">Cargando…</li>}
                        {Array.isArray(catalog) && catalog.filter((object) => !term || object.name.toLowerCase().includes(term)).map((object) => {
                          const data: DragObject = { connectionId: connection.id, name: object.name, schema: object.schema };
                          return (
                            <li key={`${object.schema ?? ''}.${object.name}`}>
                              <button type="button" className="tree-item qb-draggable" draggable onDragStart={(event) => { event.dataTransfer.setData(DRAG_MIME, JSON.stringify(data)); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => void addSource(data)} title={`${object.name} — arrastra al lienzo`}>
                                <Icon name={object.type === 'COLLECTION' ? 'folder' : 'table'} size={13} />
                                <span>{object.name.includes('/*/') ? `${object.name.split('/*/')[0]} › ${objectLabel(object)}` : objectLabel(object)}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            {!connections.isLoading && !(connections.data ?? []).length && <p className="panel-empty">No hay conexiones. <Link href="/connections">Crea una</Link>.</p>}
          </aside>

          <div className="qb-center">
            <QueryCanvas
              model={model}
              suggestions={suggestions}
              selectedSource={selected}
              onSelectSource={(id) => { setSelected(id); if (id) setPanelTab('source'); }}
              onMoveSource={(id, x, y, commit) => history.set((value) => ({ ...value, sources: value.sources.map((source) => (source.id === id ? { ...source, x, y } : source)) }), commit)}
              onRemoveSource={(id) => history.set((value) => ({ ...value, columns: [], sources: value.sources.filter((source) => source.id !== id), links: value.links.filter((link) => link.from.source !== id && link.to.source !== id) }))}
              onLink={(link) => history.set((value) => ({ ...value, links: [...value.links, { ...link, id: uid('l'), type: 'INNER' }] }))}
              onLinkChange={(id, type) => history.set((value) => ({ ...value, links: type ? value.links.map((link) => (link.id === id ? { ...link, type } : link)) : value.links.filter((link) => link.id !== id) }))}
              onAcceptSuggestion={(link: QbLink) => history.set((value) => ({ ...value, links: [...value.links, { ...link, id: uid('l') }] }))}
              onDropObject={(data, at) => { try { void addSource(JSON.parse(data) as DragObject, at); } catch { /* arrastre ajeno */ } }}
              onAutoLayout={autoLayout}
            />
            <div className="qb-status">
              <span className="status-pill" data-tone={payload ? 'ok' : 'muted'}><i />{status}</span>
              {suggestions.length > 0 && <span className="field-help">{suggestions.length} unión(es) sugerida(s): pulsa “+ Unir” en el lienzo.</span>}
              <button type="button" className="row-action" aria-pressed={showSql} onClick={() => setShowSql((value) => !value)}>{showSql ? 'Ocultar SQL' : 'Ver SQL equivalente'}</button>
            </div>
            {showSql && <pre className="json-view qb-sql" aria-label="SQL equivalente">{sql}</pre>}
            <section className="qb-preview" aria-label="Vista previa">
              <header><strong>Vista previa</strong><span className="results-meta">{isPreviewing ? 'Actualizando…' : preview ? `${preview.total.toLocaleString('es')} filas en total · se muestran 10` : 'Aparece cuando todas las fuentes están unidas'}</span></header>
              {previewError && <p className="form-error">{previewError}</p>}
              {preview && preview.rows.length > 0 && <ResultsGrid rows={preview.rows} caption="Vista previa del cruce" />}
              {preview && preview.rows.length === 0 && <p className="panel-empty">El cruce no encuentra coincidencias. Revisa las llaves (y que tengan el mismo tipo) o usa LEFT para conservar filas.</p>}
            </section>
          </div>

          <OutputPanel model={model} tab={panelTab} onTab={setPanelTab} selected={selectedSource} outputColumns={outputColumns} update={(recipe) => history.set(recipe)} />
        </div>
      )}

      {tab === 'results' && (
        <section className="surface-card qb-results">
          {!result || !resultPayload ? (
            <p className="page-message">Ejecuta la consulta para ver los resultados.</p>
          ) : (
            <>
              <header className="data-card-header">
                <h2>Resultados</h2>
                <span className="results-meta">{result.total.toLocaleString('es')} filas · página {Math.floor(result.offset / result.limit) + 1} de {Math.max(1, Math.ceil(result.total / result.limit))}</span>
                <div className="join-result-actions">
                  {!current && <button className="button form-secondary join-export-open" type="button" onClick={() => setDialog('save')}><Icon name="file" size={14} />Guardar consulta</button>}
                  {current && <Link className="button form-secondary join-export-open" href="/scheduled-tasks"><Icon name="clock" size={14} />Programar</Link>}
                  <button className="button button--primary join-export-open" type="button" disabled={result.total === 0} onClick={() => setDialog('export')}><Icon name="arrow-up-right" size={14} />Exportar</button>
                </div>
              </header>
              {aggregated && <QuickChart rows={result.data} labelColumns={model.groupBy.map((field) => model.columns.find((column) => column.name === field)?.alias || field)} metrics={model.metrics.map((metric) => metric.as)} />}
              {result.data.length ? <div className="qb-results-grid"><ResultsGrid rows={result.data} caption="Resultados de la consulta" /></div> : <p className="page-message">Sin resultados.</p>}
              <footer className="explorer-footer">
                <span>Mostrando {result.data.length} de {result.total.toLocaleString('es')}</span>
                <div>
                  <button className="row-action" type="button" disabled={result.offset === 0 || isRunning} onClick={() => void run(Math.max(0, result.offset - result.limit))}>Anterior</button>
                  <button className="row-action" type="button" disabled={result.offset + result.limit >= result.total || isRunning} onClick={() => void run(result.offset + result.limit)}>Siguiente</button>
                </div>
              </footer>
            </>
          )}
        </section>
      )}

      {tab === 'saved' && (
        <section className="surface-card data-card qb-results">
          <header className="data-card-header"><h2>Consultas guardadas</h2><button type="button" className="shell-icon-button" aria-label="Actualizar" onClick={() => void saved.reload()}><Icon name="refresh" size={14} /></button></header>
          {!(saved.data ?? []).length ? <p className="page-message">{saved.isLoading ? 'Cargando…' : 'Aún no hay consultas guardadas. Arma un cruce en el lienzo y pulsa Guardar.'}</p> : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Consulta</th><th>Fuentes</th><th>Visibilidad</th><th>Versión</th><th>Actualizada</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
                <tbody>
                  {(saved.data ?? []).map((query: SavedQuery) => {
                    const fuentes = (query.definicion as unknown as { fuentes?: { alias: string }[] } | null)?.fuentes ?? [];
                    return (
                      <tr key={query.id}>
                        <td><strong>{query.nombre}</strong><small className="cell-sub">{query.descripcion ?? (query.autor ? `por ${query.autor.name}` : '')}</small></td>
                        <td>{fuentes.map((source) => source.alias).join(' + ') || '2 fuentes'}</td>
                        <td><span className="status-pill" data-tone={query.visibilidad === 'PUBLICADA' ? 'ok' : 'muted'}><i />{query.visibilidad === 'PUBLICADA' ? 'Publicada' : 'Privada'}</span></td>
                        <td>v{query.version}</td>
                        <td>{new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(query.updatedAt))}</td>
                        <td className="cell-actions">
                          <button type="button" className="row-action" disabled={!query.definicion} onClick={() => query.definicion && void openDefinition(query.definicion, { id: query.id, nombre: query.nombre })}>Abrir</button>
                          <button type="button" className="row-action" disabled={!query.definicion} onClick={async () => {
                            if (!query.definicion) return;
                            const copy = await call((api) => api.POST('/queries', { body: { nombre: `${query.nombre} (copia)`.slice(0, 120), definicion: query.definicion!, visibilidad: 'PRIVADA' } })).catch(() => null);
                            setNotice(copy?.response.ok ? `Se duplicó "${query.nombre}".` : 'No se pudo duplicar la consulta.');
                            void saved.reload();
                          }}>Duplicar</button>
                          <Link className="row-action" href="/scheduled-tasks">Programar</Link>
                          <button type="button" className="row-action row-action--danger" onClick={async () => {
                            if (confirmDelete !== query.id) { setConfirmDelete(query.id); return; }
                            setConfirmDelete(null);
                            const removed = await call((api) => api.DELETE('/queries/{id}', { params: { path: { id: query.id } } })).catch(() => null);
                            setNotice(removed?.response.ok ? `Se eliminó "${query.nombre}".` : removed ? apiErrorMessage(removed.error, removed.response.status) : NETWORK_ERROR_MESSAGE);
                            if (current?.id === query.id) setCurrent(null);
                            void saved.reload();
                          }} onBlur={() => setConfirmDelete((value) => (value === query.id ? null : value))}>{confirmDelete === query.id ? '¿Eliminar? Confirmar' : 'Eliminar'}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {dialog === 'save' && payload && <SaveQueryModal definition={payload} columns={aggregated ? model.groupBy.length + model.metrics.length : model.columns.filter((column) => column.visible).length || outputColumns.length} onSaved={(query) => setCurrent({ ...query, savedAt: new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) })} onClose={() => { setDialog(null); void saved.reload(); }} />}
      {dialog === 'export' && resultPayload && result && <ExportModal payload={resultPayload} total={result.total} onClose={() => setDialog(null)} />}
    </div>
  );
}
