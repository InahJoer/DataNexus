'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@/components/app-shell/workspace-context';
import { ENGINES, type Connection, type DataSource } from '@/components/connections/engines';
import { excelSource, useExcelProcessingRefresh } from '@/components/explorer/excel-library';
import { objectLabel, type CatalogObject } from '@/components/explorer/explorer-tree';
import { Icon } from '@/components/icons';
import { SaveQueryModal } from '@/components/joins/save-query-modal';
import { DRAG_MIME, QueryCanvas } from '@/components/query-builder/canvas';
import { JoinTable } from '@/components/query-builder/join-table';
import {
  CARD_WIDTH,
  EMPTY_MODEL,
  aliasFor,
  detectLinks,
  fromDefinition,
  inferFields,
  normalizeModel,
  outputFields,
  outputName,
  plan,
  setOutputVisibility,
  toPayload,
  toSql,
  uid,
  withHiddenColumns,
  type JoinPayload,
  type QbLink,
  type QbModel,
  type Samples,
} from '@/components/query-builder/model';
import { OutputPanel } from '@/components/query-builder/output-panel';
import { QuickChart } from '@/components/query-builder/quick-chart';
import { ResultFilters } from '@/components/query-builder/result-filters';
import { ExportModal } from '@/components/results/export-modal';
import { ResultsGrid, type GridSort } from '@/components/results/results-grid';
import type { ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useApiQuery } from '@/lib/api/use-api-query';
import type { components } from '@/lib/api/schema';

type JoinResult = components['schemas']['PaginatedCrossJoinResultDto'];
type SavedQuery = components['schemas']['SavedQueryResponseDto'];
type DragObject = { connectionId: string; name: string; schema?: string };
type Tab = 'design' | 'results' | 'saved';
type DesignMode = 'canvas' | 'table';
type PanelTab = 'source' | 'columns' | 'group' | 'sort';

const DRAFT_KEY = 'datanexus:query-builder';
const MODE_KEY = 'datanexus:query-builder:mode';
const FAVORITES_KEY = 'datanexus:report-favorites';
const SENSITIVE = /(email|correo|telefono|phone|movil|cedula|dni|ssn|password|contrasena|tarjeta|card|iban|cuenta)/i;
const PAGE_SIZE = 50;
/** Filas de muestra por fuente: dan los tipos de los campos y los valores para detectar uniones. */
const SAMPLE_ROWS = 100;

const readStorage = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Sin almacenamiento local: la preferencia dura solo esta visita.
  }
};
const nowLabel = () => new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

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

/** Resumen de lo que guarda un reporte: fuentes, filtros, columnas y agrupación. */
function describeDefinition(definition: unknown) {
  const raw = (definition ?? {}) as {
    fuentes?: { alias: string; filtros?: unknown[] }[];
    relaciones?: unknown[];
    columnas?: string[];
    groupBy?: string[];
    filtrosResultado?: unknown[];
    ordenarPor?: unknown[];
  };
  const filters = (raw.fuentes ?? []).reduce((total, source) => total + (source.filtros?.length ?? 0), 0) + (raw.filtrosResultado?.length ?? 0);
  return {
    sources: (raw.fuentes ?? []).map((source) => source.alias),
    joins: raw.relaciones?.length ?? 0,
    view: [
      filters ? `${filters} filtro(s)` : null,
      raw.columnas?.length ? `${raw.columnas.length} columnas` : null,
      raw.groupBy?.length ? `agrupado por ${raw.groupBy.join(', ')}` : null,
      raw.ordenarPor?.length ? 'ordenado' : null,
    ].filter(Boolean).join(' · ') || 'Todas las filas y columnas',
  };
}

/**
 * Editor de consultas (#45): diseña el cruce en un lienzo (arrastrando) o en modo tabla (listas, como el editor
 * clásico), con detección inteligente de uniones por nombre y por valores reales. El resultado se puede filtrar,
 * reordenar, renombrar y ocultar columnas antes de exportar, y todo se guarda como reporte reutilizable.
 */
export function QueryBuilder() {
  const call = useApiCall();
  const { workspace } = useWorkspace();
  const connections = useApiQuery(useCallback((api: ApiClient) => api.GET('/connections'), []));
  const excels = useApiQuery(useCallback((api: ApiClient) => api.GET('/excel'), []));
  useExcelProcessingRefresh(excels.data, excels.reload);
  const saved = useApiQuery(useCallback((api: ApiClient) => api.GET('/queries'), []));
  const history = useHistory(EMPTY_MODEL);
  const { model } = history;
  const [tab, setTab] = useState<Tab>('design');
  const [mode, setMode] = useState<DesignMode>('canvas');
  const [panelTab, setPanelTab] = useState<PanelTab>('source');
  const [selected, setSelected] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, CatalogObject[] | 'loading'>>({});
  const [openConnections, setOpenConnections] = useState<Record<string, boolean>>({});
  const [paletteFilter, setPaletteFilter] = useState('');
  const [samples, setSamples] = useState<Samples>({});
  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; total: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [resultPayload, setResultPayload] = useState<JoinPayload | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [showResultPanel, setShowResultPanel] = useState(true);
  const [resultPanelTab, setResultPanelTab] = useState<PanelTab>('columns');
  const [dialog, setDialog] = useState<'save' | 'export' | null>(null);
  const [current, setCurrent] = useState<{ id: string; nombre: string; savedAt: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [reportSearch, setReportSearch] = useState('');
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const restored = useRef(false);
  const lastRunKey = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);

  // Fuentes elegibles: conexiones y archivos de Excel (el id del Excel funciona como conexionId).
  const sourcesList = useMemo<DataSource[]>(() => [...(connections.data ?? []), ...(excels.data ?? []).map(excelSource)], [connections.data, excels.data]);
  const connectionById = useCallback((id: string) => sourcesList.find((item) => item.id === id), [sourcesList]);

  // Borrador automático, modo de diseño y favoritos guardados en el dispositivo.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const raw = readStorage(DRAFT_KEY);
      if (raw) history.reset(normalizeModel(JSON.parse(raw) as Partial<QbModel>));
      const savedFavorites = readStorage(FAVORITES_KEY);
      if (savedFavorites) setFavorites(JSON.parse(savedFavorites) as string[]);
    } catch {
      // Datos locales dañados: se empieza vacío.
    }
    if (readStorage(MODE_KEY) === 'table') setMode('table');
  }, [history]);
  useEffect(() => {
    const timer = window.setTimeout(() => writeStorage(DRAFT_KEY, JSON.stringify(model)), 500);
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

  // Las fuentes del borrador recuperado necesitan su muestra para detectar uniones.
  useEffect(() => {
    const missing = model.sources.filter((source) => source.fields.length && !samples[source.id]);
    if (!missing.length || !connections.data || !excels.data) return;
    setSamples((value) => Object.fromEntries([...Object.entries(value), ...missing.map((source) => [source.id, []])]));
    for (const source of missing) {
      void loadFields(source.connectionId, source.entity, source.schema).then(({ rows }) => setSamples((value) => ({ ...value, [source.id]: rows })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.sources, connections.data, excels.data]);

  function chooseMode(next: DesignMode) {
    setMode(next);
    writeStorage(MODE_KEY, next);
  }

  function toggleFavorite(id: string) {
    setFavorites((value) => {
      const next = value.includes(id) ? value.filter((item) => item !== id) : [...value, id];
      writeStorage(FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function loadCatalog(connectionId: string) {
    if (catalogs[connectionId]) return;
    setCatalogs((value) => ({ ...value, [connectionId]: 'loading' }));
    const response = await call((api) => api.GET('/engine/connections/{connectionId}/schema', { params: { path: { connectionId } } })).catch(() => null);
    const objects = response?.data?.objects;
    setCatalogs((value) => ({ ...value, [connectionId]: objects ?? [] }));
  }

  /** Campos con su tipo (esquema + muestra) y la muestra misma, que el detector de uniones compara entre fuentes. */
  async function loadFields(connectionId: string, name: string, schema?: string) {
    const [fields, sample] = await Promise.all([
      call((api) => api.GET('/engine/connections/{connectionId}/schema/fields', { params: { path: { connectionId }, query: { objectName: name, ...(schema ? { schema } : {}) } } })).catch(() => null),
      call((api) => api.GET('/engine/connections/{connectionId}/data', { params: { path: { connectionId }, query: { entidad: name, ...(schema ? { esquema: schema } : {}), limite: SAMPLE_ROWS } } })).catch(() => null),
    ]);
    const rows = sample?.data?.data ?? [];
    return { fields: inferFields(fields?.data?.fields ?? [], rows), rows };
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
    setSamples((value) => ({ ...value, [id]: [] }));
    const { fields, rows } = await loadFields(connection.id, object.name, object.schema);
    setSamples((value) => ({ ...value, [id]: rows }));
    history.set((value) => ({ ...value, sources: value.sources.map((source) => (source.id === id ? { ...source, fields } : source)) }), false);
  }

  function removeSource(id: string) {
    history.set((value) => ({ ...value, columns: [], sources: value.sources.filter((source) => source.id !== id), links: value.links.filter((link) => link.from.source !== id && link.to.source !== id) }));
    if (selected === id) setSelected(null);
  }

  /** Abre una consulta guardada o importada: carga los campos y la muestra de cada fuente y reconstruye el diseño. */
  async function openDefinition(definition: JoinPayload, meta: { id: string; nombre: string } | null): Promise<QbModel | null> {
    const raw = definition as unknown as { fuentes?: { alias: string; conexionId: string; entidad: string; esquema?: string }[] };
    if (!raw.fuentes?.length) {
      setNotice('Esta consulta usa el formato antiguo de 2 fuentes; vuelve a crearla en el editor.');
      return null;
    }
    setNotice('Abriendo…');
    const loaded = await Promise.all(raw.fuentes.map(async (source) => {
      const connection = connectionById(source.conexionId);
      const { fields, rows } = await loadFields(source.conexionId, source.entidad, source.esquema);
      return {
        source: {
          id: uid('src'),
          alias: source.alias,
          connectionId: source.conexionId,
          connectionName: connection?.nombre ?? connection?.dbName ?? 'Conexión no disponible',
          engine: connection?.tipoMotor ?? 'POSTGRESQL',
          entity: source.entidad,
          schema: source.esquema,
          fields,
        },
        rows,
      };
    }));
    const next = withHiddenColumns(fromDefinition(definition, loaded.map((item) => item.source)));
    setSamples(Object.fromEntries(loaded.map((item) => [item.source.id, item.rows])));
    history.reset(next);
    setCurrent(meta ? { ...meta, savedAt: null } : null);
    setResult(null);
    setNotice(meta ? `"${meta.nombre}" abierto.` : 'Consulta importada.');
    return next;
  }

  // Columnas que producirá el cruce: un nombre repetido entre fuentes se califica con el alias (como el motor).
  const outputColumns = useMemo(() => {
    const sensitiveConfigured = new Set((workspace.data?.configuracion?.camposSensibles ?? []).map((field) => field.toLowerCase()));
    return outputFields(model).map((field) => {
      const base = field.name.split('.').pop() ?? field.name;
      return { ...field, sensitive: SENSITIVE.test(base) || sensitiveConfigured.has(base.toLowerCase()) };
    });
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

  const suggestions = useMemo(() => detectLinks(model, samples), [model, samples]);
  // Columnas quitadas del resultado (desde las tarjetas del lienzo o el panel Salida).
  const hiddenOutputs = useMemo(() => new Set(model.columns.filter((column) => !column.visible).map((column) => column.name)), [model.columns]);
  const { disconnected } = plan(model);
  const payload = useMemo(() => toPayload(model), [model]);
  const sql = useMemo(() => toSql(model), [model]);
  const payloadKey = payload ? JSON.stringify({ ...payload, lienzo: undefined }) : '';
  const aggregated = model.groupBy.length > 0 || model.metrics.length > 0;

  // Nombres tal como salen en la tabla combinada (con alias) y el camino de vuelta al nombre original.
  const aliasOf = useCallback((name: string) => model.columns.find((column) => column.name === name)?.alias.trim() || name, [model.columns]);
  const originalOf = (display: string) => model.columns.find((column) => column.alias.trim() === display)?.name ?? display;
  const resultColumns = useMemo(() => {
    if (aggregated) return [...model.groupBy, ...model.metrics.map((metric) => metric.as.trim()).filter(Boolean)].map(aliasOf);
    const chosen = model.columns.length ? model.columns.filter((column) => column.visible).map((column) => column.name) : outputColumns.map((column) => column.name);
    return chosen.map(aliasOf);
  }, [aggregated, model.groupBy, model.metrics, model.columns, outputColumns, aliasOf]);
  const gridSort: GridSort = model.sort[0] ? { column: aliasOf(model.sort[0].campo), direction: model.sort[0].direccion === 'ASC' ? 'asc' : 'desc' } : null;
  const setGridSort = (sort: GridSort) =>
    history.set((value) => ({ ...value, sort: sort ? [{ campo: originalOf(sort.column), direccion: sort.direction === 'asc' ? 'ASC' : 'DESC' }] : [] }));

  // Vista previa en vivo (10 filas) cuando el cruce está completo; se pide 900 ms después del último cambio.
  useEffect(() => {
    if (!payload || tab !== 'design') {
      if (!payload) {
        setPreview(null);
        setPreviewError(null);
      }
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
  }, [payloadKey, tab]);

  async function run(offset = 0, explicit?: JoinPayload | null) {
    const body = explicit ?? payload;
    if (!body) return;
    lastRunKey.current = JSON.stringify({ ...body, lienzo: undefined });
    setIsRunning(true);
    setRunError(null);
    try {
      const response = await call((api) => api.POST('/engine/join', { body: { ...body, limit: PAGE_SIZE, offset } }));
      if (!response.response.ok || !response.data) {
        setRunError(apiErrorMessage(response.error, response.response.status));
        return;
      }
      setResult(response.data);
      setResultPayload(body);
      setTab('results');
    } catch {
      setRunError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsRunning(false);
    }
  }

  // En Resultados, cada cambio de filtros, columnas, orden o agrupación vuelve a ejecutar el cruce (desde la página 1).
  useEffect(() => {
    if (tab !== 'results' || !payload || !result || payloadKey === lastRunKey.current) return;
    const timer = window.setTimeout(() => void run(0), 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, payloadKey]);

  async function saveChanges() {
    if (!current || !payload) return;
    const response = await call((api) => api.PATCH('/queries/{id}', { params: { path: { id: current.id } }, body: { definicion: payload } })).catch(() => null);
    if (response?.response.ok) {
      setCurrent({ ...current, savedAt: nowLabel() });
      void saved.reload();
    } else {
      setNotice(response ? apiErrorMessage(response.error, response.response.status) : NETWORK_ERROR_MESSAGE);
    }
  }

  async function runReport(query: SavedQuery) {
    if (!query.definicion) return;
    const next = await openDefinition(query.definicion, { id: query.id, nombre: query.nombre });
    const body = next ? toPayload(next) : null;
    if (!body) {
      setTab('design');
      if (next) setNotice(`"${query.nombre}" tiene fuentes sin unir: revísalas en el diseño.`);
      return;
    }
    await run(0, body);
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
      setTab('design');
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

  const reports = useMemo(() => {
    const term = reportSearch.trim().toLowerCase();
    return (saved.data ?? [])
      .filter((query) => (!onlyFavorites || favorites.includes(query.id)) && (!term || `${query.nombre} ${query.descripcion ?? ''}`.toLowerCase().includes(term)))
      .sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)));
  }, [saved.data, reportSearch, onlyFavorites, favorites]);

  const selectedSource = model.sources.find((source) => source.id === selected) ?? null;
  const status = model.sources.length < 2
    ? 'Agrega al menos dos fuentes'
    : disconnected.length ? `Une ${disconnected.map((source) => source.alias).join(', ')} con otra fuente` : 'Listo para ejecutar';
  const term = paletteFilter.trim().toLowerCase();
  const columnsCount = aggregated ? model.groupBy.length + model.metrics.length : model.columns.filter((column) => column.visible).length || outputColumns.length;

  return (
    <div className="qb">
      <div className="qb-toolbar">
        <div className="segmented" role="tablist" aria-label="Vista">
          {([['design', 'Diseño'], ['results', 'Resultados'], ['saved', 'Reportes guardados']] as const).map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} aria-pressed={tab === value} onClick={() => setTab(value)}>
              {label}{value === 'saved' && saved.data ? ` (${saved.data.length})` : ''}{value === 'results' && result ? ` (${result.total.toLocaleString('es')})` : ''}
            </button>
          ))}
        </div>
        <span className="qb-title">{current ? <><strong>{current.nombre}</strong>{current.savedAt && <small>Guardado a las {current.savedAt}</small>}</> : <small>Consulta sin guardar · borrador automático</small>}</span>
        <div className="qb-actions">
          <button type="button" className="shell-icon-button" aria-label="Deshacer (Ctrl+Z)" title="Deshacer (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}>↶</button>
          <button type="button" className="shell-icon-button" aria-label="Rehacer (Ctrl+Y)" title="Rehacer (Ctrl+Y)" disabled={!history.canRedo} onClick={history.redo}>↷</button>
          <button type="button" className="button form-secondary compact-button" onClick={() => { history.set(() => EMPTY_MODEL); setCurrent(null); setResult(null); setSamples({}); setTab('design'); }}>Nuevo</button>
          <button type="button" className="button form-secondary compact-button" onClick={() => fileInput.current?.click()}>Importar</button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importJson(file); event.target.value = ''; }} />
          <button type="button" className="button form-secondary compact-button" disabled={!payload} onClick={exportJson}>Exportar JSON</button>
          {current && <button type="button" className="button form-secondary compact-button" disabled={!payload} onClick={() => void saveChanges()}><Icon name="file" size={13} />Guardar cambios</button>}
          <button type="button" className="button form-secondary compact-button" disabled={!payload} onClick={() => setDialog('save')}><Icon name="file" size={13} />{current ? 'Guardar como…' : 'Guardar reporte'}</button>
          <button type="button" className="button button--primary compact-button" disabled={!payload || isRunning} onClick={() => void run(0)}><Icon name="join" size={13} />{isRunning ? 'Ejecutando…' : 'Ejecutar'}</button>
        </div>
      </div>
      {notice && <p className="page-notice qb-notice" role="status">{notice} <button type="button" className="inline-link auth-link" onClick={() => setNotice(null)}>Cerrar</button></p>}
      {runError && <p className="form-error qb-notice" role="alert">{runError}</p>}

      {tab === 'design' && (
        <div className="qb-workspace">
          <aside className="qb-palette" aria-label="Fuentes disponibles">
            <label className="search-field"><Icon name="search" size={13} /><input type="search" placeholder="Buscar tabla o colección" value={paletteFilter} onChange={(event) => setPaletteFilter(event.target.value)} aria-label="Buscar fuentes" /></label>
            <p className="field-help">{mode === 'canvas' ? 'Arrastra al lienzo o haz clic para agregar.' : 'Haz clic para agregar al cruce.'}</p>
            <div className="qb-palette-group"><span>Bases de datos</span></div>
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
                              <button type="button" className="tree-item qb-draggable" draggable={mode === 'canvas'} onDragStart={(event) => { event.dataTransfer.setData(DRAG_MIME, JSON.stringify(data)); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => void addSource(data)} title={mode === 'canvas' ? `${object.name} — arrastra al lienzo` : `Agregar ${object.name}`}>
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
            <div className="qb-palette-group">
              <span>Excels</span>
              <Link className="auth-link" href="/explorer?vista=excel">+ Subir</Link>
            </div>
            <ul className="tree-root">
              {(excels.data ?? []).map((file) => {
                const sheets = file.hojas.filter((sheet) => !term || sheet.nombre.toLowerCase().includes(term) || file.nombre.toLowerCase().includes(term));
                if (!sheets.length) {
                  // Un Excel que aún se está cargando se muestra con su avance (sus hojas aparecen al terminar).
                  if (file.estado !== 'PROCESANDO' || (term && !file.nombre.toLowerCase().includes(term))) return null;
                  return (
                    <li key={file.id}>
                      <span className="tree-connection" title="Se está cargando en segundo plano">
                        <span className="engine-badge" data-engine="EXCEL">XL</span>
                        <span className="tree-connection-name">{file.nombre}<small>Procesando… {file.progreso}%</small></span>
                      </span>
                    </li>
                  );
                }
                const open = openConnections[file.id] ?? true;
                return (
                  <li key={file.id}>
                    <button type="button" className="tree-connection" aria-expanded={open} onClick={() => setOpenConnections((value) => ({ ...value, [file.id]: !(value[file.id] ?? true) }))}>
                      <Icon name="chevron-right" size={12} className={open ? 'tree-caret tree-caret--open' : 'tree-caret'} />
                      <span className="engine-badge" data-engine="EXCEL">XL</span>
                      <span className="tree-connection-name">{file.nombre}<small>{file.hojas.length === 1 ? 'Excel · 1 hoja' : `Excel · ${file.hojas.length} hojas`}</small></span>
                    </button>
                    {open && (
                      <ul className="tree-children">
                        {sheets.map((sheet) => {
                          const data: DragObject = { connectionId: file.id, name: sheet.nombre };
                          return (
                            <li key={sheet.nombre}>
                              <button type="button" className="tree-item qb-draggable" draggable={mode === 'canvas'} onDragStart={(event) => { event.dataTransfer.setData(DRAG_MIME, JSON.stringify(data)); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => void addSource(data)} title={`${sheet.nombre} · ${sheet.totalFilas} registros · identificador: ${sheet.columnaId}`}>
                                <Icon name="table" size={13} />
                                <span>{sheet.nombre}</span>
                                <small className="qb-sheet-id">ID: {sheet.columnaId}</small>
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
            {!excels.isLoading && !(excels.data ?? []).length && <p className="tree-note">Sin archivos. <Link className="auth-link" href="/explorer?vista=excel">Sube un Excel</Link> para cruzarlo con tus bases de datos.</p>}
            {!connections.isLoading && !(connections.data ?? []).length && <p className="panel-empty">No hay conexiones. <Link href="/connections">Crea una</Link>.</p>}
          </aside>

          <div className="qb-center">
            <div className="qb-mode-bar">
              <div className="segmented" role="group" aria-label="Modo de diseño">
                <button type="button" aria-pressed={mode === 'canvas'} onClick={() => chooseMode('canvas')}><Icon name="join" size={13} />Query Builder</button>
                <button type="button" aria-pressed={mode === 'table'} onClick={() => chooseMode('table')}><Icon name="table" size={13} />Tabla de uniones</button>
              </div>
              <span className="field-help">{mode === 'canvas' ? 'Une campos arrastrando de un punto a otro.' : 'Elige fuentes, campos y tipo de unión en listas.'}</span>
            </div>
            {mode === 'canvas' ? (
              <QueryCanvas
                model={model}
                suggestions={suggestions.map((item) => item.link)}
                selectedSource={selected}
                onSelectSource={(id) => { setSelected(id); if (id) setPanelTab('source'); }}
                onMoveSource={(id, x, y, commit) => history.set((value) => ({ ...value, sources: value.sources.map((source) => (source.id === id ? { ...source, x, y } : source)) }), commit)}
                onRemoveSource={removeSource}
                onLink={(link) => history.set((value) => ({ ...value, links: [...value.links, { ...link, id: uid('l'), type: 'INNER' }] }))}
                onLinkChange={(id, type) => history.set((value) => ({ ...value, links: type ? value.links.map((link) => (link.id === id ? { ...link, type } : link)) : value.links.filter((link) => link.id !== id) }))}
                onAcceptSuggestion={(link: QbLink) => history.set((value) => ({ ...value, links: [...value.links, { ...link, id: uid('l') }] }))}
                onDropObject={(data, at) => { try { void addSource(JSON.parse(data) as DragObject, at); } catch { /* arrastre ajeno */ } }}
                onAutoLayout={autoLayout}
                isExcluded={(source, field) => hiddenOutputs.has(outputName(model, source, field))}
                onToggleFields={(source, fields, include) => {
                  const names = fields.map((field) => outputName(model, source, field));
                  if (setOutputVisibility(model, names, include) === model) setNotice('El resultado necesita al menos una columna: deja marcado algún campo.');
                  else history.set((value) => setOutputVisibility(value, names, include));
                }}
              />
            ) : (
              <JoinTable
                model={model}
                suggestions={suggestions}
                selectedSource={selected}
                onSelectSource={(id) => { setSelected(id); setPanelTab('source'); }}
                onRemoveSource={removeSource}
                update={(recipe) => history.set(recipe)}
              />
            )}
            <div className="qb-status">
              <span className="status-pill" data-tone={payload ? 'ok' : 'muted'}><i />{status}</span>
              {suggestions.length > 0 && (
                <button type="button" className="row-action qb-smart" onClick={() => chooseMode('table')} title="Ver por qué se sugieren">
                  <Icon name="spark" size={12} />{suggestions.length} unión(es) detectada(s){mode === 'canvas' ? ': “+ Unir” en el lienzo o revísalas en la tabla' : ''}
                </button>
              )}
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
            <div className="qb-results-empty">
              <p className="page-message">{payload ? 'El cruce está listo. Ejecútalo para ver la tabla combinada.' : 'Diseña el cruce (dos o más fuentes unidas) y ejecútalo para ver los resultados.'}</p>
              {payload && <button type="button" className="button button--primary compact-button" disabled={isRunning} onClick={() => void run(0)}><Icon name="join" size={13} />Ejecutar</button>}
            </div>
          ) : (
            <>
              <header className="data-card-header">
                <h2>{current?.nombre ?? 'Tabla combinada'}</h2>
                <span className="results-meta">
                  {isRunning ? 'Actualizando…' : `${result.total.toLocaleString('es')} filas · página ${Math.floor(result.offset / result.limit) + 1} de ${Math.max(1, Math.ceil(result.total / result.limit))}`}
                  {result.truncado ? ' · recortado por el límite de filas' : ''}
                </span>
                <div className="join-result-actions">
                  <button className="button form-secondary join-export-open" type="button" aria-pressed={showResultPanel} onClick={() => setShowResultPanel((value) => !value)}><Icon name="settings" size={14} />Columnas y orden</button>
                  {current
                    ? <button className="button form-secondary join-export-open" type="button" onClick={() => void saveChanges()}><Icon name="file" size={14} />Guardar cambios</button>
                    : <button className="button form-secondary join-export-open" type="button" onClick={() => setDialog('save')}><Icon name="file" size={14} />Guardar reporte</button>}
                  {current && <Link className="button form-secondary join-export-open" href={`/scheduled-tasks?consulta=${current.id}`}><Icon name="clock" size={14} />Programar</Link>}
                  <button className="button button--primary join-export-open" type="button" disabled={result.total === 0} onClick={() => setDialog('export')}><Icon name="arrow-up-right" size={14} />Exportar</button>
                </div>
              </header>
              <ResultFilters model={model} columns={resultColumns} update={(recipe) => history.set(recipe)} />
              {aggregated && <QuickChart rows={result.data} labelColumns={model.groupBy.map(aliasOf)} metrics={model.metrics.map((metric) => aliasOf(metric.as))} />}
              <div className="qb-results-body" data-panel={showResultPanel || undefined}>
                <div className="qb-results-grid">
                  {result.data.length
                    ? <ResultsGrid rows={result.data} columns={resultColumns} caption="Tabla combinada" sort={gridSort} onSortChange={setGridSort} />
                    : <p className="page-message">Ninguna fila cumple los filtros.</p>}
                </div>
                {showResultPanel && (
                  <OutputPanel
                    model={model}
                    tab={resultPanelTab === 'source' ? 'columns' : resultPanelTab}
                    onTab={(next) => setResultPanelTab(next === 'source' ? 'columns' : next)}
                    selected={null}
                    outputColumns={outputColumns}
                    update={(recipe) => history.set(recipe)}
                    hideSourceTab
                  />
                )}
              </div>
              <footer className="explorer-footer">
                <span>Mostrando {result.data.length} de {result.total.toLocaleString('es')} · lo que ves es lo que se exporta y se guarda en el reporte</span>
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
          <header className="data-card-header qb-reports-head">
            <h2>Reportes guardados</h2>
            <label className="search-field"><Icon name="search" size={13} /><input type="search" placeholder="Buscar reporte" value={reportSearch} onChange={(event) => setReportSearch(event.target.value)} aria-label="Buscar reportes" /></label>
            <div className="segmented" role="group" aria-label="Mostrar">
              <button type="button" aria-pressed={!onlyFavorites} onClick={() => setOnlyFavorites(false)}>Todos</button>
              <button type="button" aria-pressed={onlyFavorites} onClick={() => setOnlyFavorites(true)}>★ Favoritos</button>
            </div>
            <button type="button" className="shell-icon-button" aria-label="Actualizar" onClick={() => void saved.reload()}><Icon name="refresh" size={14} /></button>
          </header>
          <p className="field-help qb-reports-help">Cada reporte guarda las fuentes, las uniones, los filtros, las columnas (orden y nombres) y el orden de las filas. Ejecútalo cuando quieras o prográmalo para recibirlo por correo.</p>
          {!reports.length ? (
            <p className="page-message">{saved.isLoading ? 'Cargando…' : (saved.data ?? []).length ? 'Ningún reporte coincide.' : 'Aún no hay reportes. Arma un cruce, ajusta la tabla y pulsa “Guardar reporte”.'}</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table qb-reports-table">
                <thead><tr><th><span className="visually-hidden">Favorito</span></th><th>Reporte</th><th>Fuentes</th><th>Vista guardada</th><th>Visibilidad</th><th>Actualizado</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
                <tbody>
                  {reports.map((query: SavedQuery) => {
                    const info = describeDefinition(query.definicion);
                    const favorite = favorites.includes(query.id);
                    return (
                      <tr key={query.id} data-current={current?.id === query.id || undefined}>
                        <td><button type="button" className="qb-star" aria-pressed={favorite} aria-label={favorite ? 'Quitar de favoritos' : 'Marcar como favorito'} onClick={() => toggleFavorite(query.id)}>{favorite ? '★' : '☆'}</button></td>
                        <td><strong>{query.nombre}</strong><small className="cell-sub">{query.descripcion ?? (query.autor ? `por ${query.autor.name}` : '')}</small></td>
                        <td>{info.sources.join(' + ') || '2 fuentes'}{info.joins > 0 && <small className="cell-sub">{info.joins} unión(es)</small>}</td>
                        <td><small>{info.view}</small></td>
                        <td><span className="status-pill" data-tone={query.visibilidad === 'PUBLICADA' ? 'ok' : 'muted'}><i />{query.visibilidad === 'PUBLICADA' ? 'Publicado' : 'Privado'}</span></td>
                        <td>{new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(query.updatedAt))}<small className="cell-sub">v{query.version}</small></td>
                        <td className="cell-actions">
                          <button type="button" className="button button--primary compact-button" disabled={!query.definicion || isRunning} onClick={() => void runReport(query)}>Ejecutar</button>
                          <button type="button" className="row-action" disabled={!query.definicion} onClick={async () => { if (query.definicion && await openDefinition(query.definicion, { id: query.id, nombre: query.nombre })) setTab('design'); }}>Editar</button>
                          <button type="button" className="row-action" disabled={!query.definicion} onClick={async () => {
                            if (!query.definicion) return;
                            const copy = await call((api) => api.POST('/queries', { body: { nombre: `${query.nombre} (copia)`.slice(0, 120), definicion: query.definicion!, visibilidad: 'PRIVADA' } })).catch(() => null);
                            setNotice(copy?.response.ok ? `Se duplicó "${query.nombre}".` : 'No se pudo duplicar el reporte.');
                            void saved.reload();
                          }}>Duplicar</button>
                          <Link className="row-action" href={`/scheduled-tasks?consulta=${query.id}`}>Programar</Link>
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

      {dialog === 'save' && payload && (
        <SaveQueryModal
          definition={payload}
          columns={columnsCount}
          onSaved={(query) => { setCurrent({ ...query, savedAt: nowLabel() }); setNotice(null); }}
          onClose={() => { setDialog(null); void saved.reload(); }}
        />
      )}
      {dialog === 'export' && resultPayload && result && (
        <ExportModal
          target={{ kind: 'join', payload: resultPayload, total: result.total }}
          defaultName={(current?.nombre ?? 'datanexus-cruce').replace(/[^\w-]+/g, '-')}
          summary={`${result.total.toLocaleString('es')} filas, ${resultColumns.length} columnas${model.resultFilters.length ? `, ${model.resultFilters.length} filtro(s)` : ''}, tal como se ven en la tabla.`}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
