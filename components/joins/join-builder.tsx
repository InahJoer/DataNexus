'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ENGINES, type Connection } from '@/components/connections/engines';
import { objectLabel, type CatalogObject } from '@/components/explorer/explorer-tree';
import { Icon } from '@/components/icons';
import { ColumnManager, mergeColumns, type ColumnSetting } from '@/components/results/column-manager';
import { ExportModal } from '@/components/results/export-modal';
import { SaveQueryModal } from '@/components/joins/save-query-modal';
import { ResultsGrid } from '@/components/results/results-grid';
import type { ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useApiQuery } from '@/lib/api/use-api-query';
import type { components } from '@/lib/api/schema';

type JoinPayload = components['schemas']['CrossJoinDto'];
type JoinResult = components['schemas']['PaginatedCrossJoinResultDto'];
type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';

type Source = {
  id: number;
  connectionId: string;
  objectKey: string;
  alias: string;
  /** Relación con una fuente anterior (no aplica a la primera). */
  joinWith: string;
  joinType: JoinType;
  leftField: string;
  rightField: string;
};

const MAX_SOURCES = 5;
const PAGE_SIZE = 50;
const JOIN_TYPES: { value: JoinType; label: string; detail: string }[] = [
  { value: 'INNER', label: 'INNER', detail: 'solo coincidencias' },
  { value: 'LEFT', label: 'LEFT', detail: 'todo lo anterior' },
  { value: 'RIGHT', label: 'RIGHT', detail: 'todo esta fuente' },
  { value: 'FULL', label: 'FULL', detail: 'todo de ambos' },
];

const objectKey = (object: CatalogObject) => `${object.schema ?? ''}::${object.name}`;

/** Alias válido para la API (letra inicial, letras, números o _), derivado del nombre de la tabla o colección. */
function aliasFor(name: string, taken: string[]) {
  const base = (name.split('/').pop() ?? 'fuente').normalize('NFD').replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '').slice(0, 24) || 'fuente';
  let alias = base;
  for (let n = 2; taken.includes(alias); n += 1) alias = `${base}${n}`;
  return alias;
}

let nextId = 1;
const emptySource = (): Source => ({ id: nextId++, connectionId: '', objectKey: '', alias: '', joinWith: '', joinType: 'INNER', leftField: '', rightField: '' });

/**
 * Constructor de cruces multi-fuente: de 2 a 5 tablas o colecciones de cualquier conexión (SQL con SQL, colección con
 * colección del mismo Firebase, subcolecciones con su colección padre, SQL con NoSQL…), cada una relacionada con una
 * fuente anterior por un campo y un tipo de join.
 */
export function JoinBuilder() {
  const call = useApiCall();
  const connections = useApiQuery(useCallback((api: ApiClient) => api.GET('/connections'), []));
  const [sources, setSources] = useState<Source[]>(() => [emptySource(), emptySource()]);
  const [catalogs, setCatalogs] = useState<Record<string, CatalogObject[]>>({});
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<JoinResult | null>(null);
  const [payload, setPayload] = useState<JoinPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isSaveOpen, setIsSaveOpen] = useState(false);
  const [columns, setColumns] = useState<ColumnSetting[]>([]);
  const [showColumns, setShowColumns] = useState(true);
  // Catálogos y campos ya pedidos: evita repetir la petición mientras la primera sigue en curso.
  const requested = useRef(new Set<string>());

  const connectionById = (id: string) => connections.data?.find((connection) => connection.id === id);
  const objectOf = (source: Source) => catalogs[source.connectionId]?.find((object) => objectKey(object) === source.objectKey);
  const fieldsOf = (source: Source) => fields[`${source.connectionId}|${source.objectKey}`] ?? [];

  const loadCatalog = useCallback(async (connectionId: string) => {
    if (catalogs[connectionId] || requested.current.has(connectionId)) return;
    requested.current.add(connectionId);
    const result = await call((api) => api.GET('/engine/connections/{connectionId}/schema', { params: { path: { connectionId } } }));
    const objects = result.data?.objects;
    if (result.response.ok && objects) setCatalogs((current) => ({ ...current, [connectionId]: objects }));
    else setError(apiErrorMessage(result.error, result.response.status));
  }, [call, catalogs]);

  const loadFields = useCallback(async (connectionId: string, object: CatalogObject) => {
    const key = `${connectionId}|${objectKey(object)}`;
    if (fields[key] || requested.current.has(key)) return;
    requested.current.add(key);
    const result = await call((api) =>
      api.GET('/engine/connections/{connectionId}/schema/fields', {
        params: { path: { connectionId }, query: { objectName: object.name, ...(object.schema ? { schema: object.schema } : {}) } },
      }),
    );
    if (result.response.ok && result.data) {
      const list = result.data.fields;
      // Los documentos llevan además su id (y en subcolecciones, el id del padre) para poder relacionarlos.
      const extra = ENGINES[connectionById(connectionId)?.tipoMotor ?? 'POSTGRESQL'].kind === 'firestore' ? ['__documentId'] : [];
      setFields((current) => ({ ...current, [key]: [...new Set([...extra, ...list])] }));
    }
  }, [call, fields, connections.data]);

  useEffect(() => {
    for (const source of sources) {
      if (source.connectionId) void loadCatalog(source.connectionId);
      const object = objectOf(source);
      if (object) void loadFields(source.connectionId, object);
    }
  });

  function update(id: number, patch: Partial<Source>) {
    setSources((current) => current.map((source) => (source.id === id ? { ...source, ...patch } : source)));
    setResult(null);
  }

  function chooseObject(source: Source, key: string) {
    const object = catalogs[source.connectionId]?.find((item) => objectKey(item) === key);
    const taken = sources.filter((other) => other.id !== source.id).map((other) => other.alias);
    update(source.id, { objectKey: key, alias: object ? aliasFor(object.name, taken) : '', rightField: '', leftField: '' });
  }

  const ready = sources.every((source, index) =>
    source.connectionId && source.objectKey && source.alias && (index === 0 || (source.joinWith && source.leftField && source.rightField)),
  );

  async function run(offset = 0, base?: JoinPayload) {
    const body: JoinPayload = base ?? {
      fuentes: sources.map((source) => {
        const object = objectOf(source);
        return { alias: source.alias, conexionId: source.connectionId, entidad: object?.name ?? '', ...(object?.schema ? { esquema: object.schema } : {}) };
      }),
      relaciones: sources.slice(1).map((source) => ({
        izquierda: source.joinWith,
        derecha: source.alias,
        tipo: source.joinType,
        llaves: [{ izquierda: source.leftField, derecha: source.rightField }],
      })),
      limit: PAGE_SIZE,
    };
    setIsRunning(true);
    setError(null);
    try {
      const response = await call((api) => api.POST('/engine/join', { body: { ...body, offset } }));
      if (!response.response.ok || !response.data) {
        setError(apiErrorMessage(response.error, response.response.status));
        return;
      }
      setPayload(body);
      setResult(response.data);
      const available = [...new Set(response.data.data.flatMap((row) => Object.keys(row)))];
      setColumns((current) => mergeColumns(current, available));
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsRunning(false);
    }
  }

  const visibleColumns = useMemo(() => columns.filter((column) => column.visible).map((column) => column.name), [columns]);
  // Lo que se exporta y se guarda: el cruce más las columnas elegidas (si se ocultó alguna o se cambió el orden).
  const outputPayload = useMemo<JoinPayload | null>(() => {
    if (!payload) return null;
    const changed = columns.some((column, index) => !column.visible || column.name !== Object.keys(result?.data[0] ?? {})[index]);
    return changed && visibleColumns.length ? { ...payload, columnas: visibleColumns } : payload;
  }, [payload, columns, visibleColumns, result]);

  if (connections.isLoading) return <p className="page-message">Cargando conexiones…</p>;
  const available: Connection[] = connections.data ?? [];

  const page = result ? Math.floor(result.offset / result.limit) + 1 : 1;
  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.limit)) : 1;

  return (
    <section className="surface-card join-multi" aria-labelledby="join-multi-title">
      <header className="data-card-header">
        <h2 id="join-multi-title">Fuentes del cruce</h2>
        <span className="results-meta">De 2 a {MAX_SOURCES} tablas o colecciones de cualquier conexión</span>
      </header>

      <ol className="join-sources">
        {sources.map((source, index) => {
          const catalog = catalogs[source.connectionId] ?? [];
          const previous = sources.slice(0, index).filter((item) => item.alias);
          const left = sources.find((item) => item.alias === source.joinWith);
          const connection = connectionById(source.connectionId);
          return (
            <li key={source.id} className="join-source">
              <div className="join-source-head">
                <span className="join-step">{index + 1}</span>
                {connection && <span className="engine-badge" data-engine={connection.tipoMotor}>{ENGINES[connection.tipoMotor].short}</span>}
                <strong>{source.alias || `Fuente ${index + 1}`}</strong>
                {sources.length > 2 && (
                  <button type="button" className="row-action row-action--danger join-remove" onClick={() => {
                    setSources((current) => current.filter((item) => item.id !== source.id).map((item) => (item.joinWith === source.alias ? { ...item, joinWith: '' } : item)));
                    setResult(null);
                  }}>Quitar</button>
                )}
              </div>
              <div className="join-source-fields">
                <label className="form-field">
                  <span>Conexión</span>
                  <select className="form-input" value={source.connectionId} onChange={(event) => update(source.id, { connectionId: event.target.value, objectKey: '', alias: '', leftField: '', rightField: '' })}>
                    <option value="">Selecciona…</option>
                    {available.map((item) => <option key={item.id} value={item.id}>{item.nombre ?? item.dbName} · {ENGINES[item.tipoMotor].label}</option>)}
                  </select>
                </label>
                <label className="form-field">
                  <span>Tabla o colección</span>
                  <select className="form-input" value={source.objectKey} disabled={!source.connectionId} onChange={(event) => chooseObject(source, event.target.value)}>
                    <option value="">{source.connectionId && !catalogs[source.connectionId] ? 'Cargando…' : 'Selecciona…'}</option>
                    {catalog.map((object) => (
                      <option key={objectKey(object)} value={objectKey(object)}>
                        {object.name.includes('/*/') ? `${object.name.split('/*/')[0]} › ${objectLabel(object)} (subcolección)` : objectLabel(object)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>Alias</span>
                  <input className="form-input" value={source.alias} maxLength={32} pattern="[A-Za-z][A-Za-z0-9_]*" onChange={(event) => update(source.id, { alias: event.target.value })} />
                </label>
              </div>
              {index > 0 && (
                <div className="join-relation">
                  <span className="join-relation-label"><Icon name="join" size={14} />Se une con</span>
                  <select className="form-input" value={source.joinWith} onChange={(event) => update(source.id, { joinWith: event.target.value, leftField: '' })} aria-label="Fuente anterior">
                    <option value="">fuente…</option>
                    {previous.map((item) => <option key={item.id} value={item.alias}>{item.alias}</option>)}
                  </select>
                  <select className="form-input" value={source.leftField} disabled={!left} onChange={(event) => update(source.id, { leftField: event.target.value })} aria-label="Campo de la fuente anterior">
                    <option value="">campo…</option>
                    {left && fieldsOf(left).map((field) => <option key={field} value={field}>{field}</option>)}
                  </select>
                  <span className="join-equals">=</span>
                  <select className="form-input" value={source.rightField} disabled={!source.objectKey} onChange={(event) => update(source.id, { rightField: event.target.value })} aria-label="Campo de esta fuente">
                    <option value="">campo de {source.alias || 'esta fuente'}…</option>
                    {fieldsOf(source).map((field) => <option key={field} value={field}>{field}</option>)}
                  </select>
                  <select className="form-input" value={source.joinType} onChange={(event) => update(source.id, { joinType: event.target.value as JoinType })} aria-label="Tipo de join">
                    {JOIN_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label} · {type.detail}</option>)}
                  </select>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="join-multi-actions">
        <button type="button" className="button form-secondary" disabled={sources.length >= MAX_SOURCES} onClick={() => setSources((current) => [...current, emptySource()])}>
          + Agregar fuente
        </button>
        <button type="button" className="button button--primary form-primary" disabled={!ready || isRunning} onClick={() => void run(0)}>
          <Icon name="join" size={15} />{isRunning ? 'Ejecutando…' : 'Ejecutar cruce'}
        </button>
      </div>
      {error && <p className="form-error explorer-error" role="alert">{error}</p>}

      {result && payload && (
        <section className="join-multi-results" aria-label="Resultados del cruce">
          <header className="data-card-header">
            <h2>Resultados</h2>
            <span className="results-meta">{result.total.toLocaleString('es')} filas · página {page} de {totalPages}</span>
            {result.total > 0 && (
              <div className="join-result-actions">
                <button className="button form-secondary join-export-open" type="button" aria-pressed={showColumns} onClick={() => setShowColumns((value) => !value)}><Icon name="table" size={15} />Columnas ({visibleColumns.length}/{columns.length})</button>
                <button className="button form-secondary join-export-open" type="button" onClick={() => setIsSaveOpen(true)}><Icon name="file" size={15} />Guardar consulta</button>
                <button className="button button--primary join-export-open" type="button" disabled={visibleColumns.length === 0} onClick={() => setIsExportOpen(true)}><Icon name="arrow-up-right" size={15} />Exportar</button>
              </div>
            )}
          </header>
          {result.data.length === 0 ? (
            <p className="page-message">El cruce no encontró coincidencias. Revisa que los campos relacionados tengan los mismos valores (y el mismo tipo).</p>
          ) : (
            <div className="join-results-layout" data-with-columns={showColumns || undefined}>
              {visibleColumns.length === 0
                ? <p className="page-message">No hay columnas visibles. Marca al menos una en el panel de columnas.</p>
                : <ResultsGrid rows={result.data} columns={visibleColumns} caption={`Resultados del cruce, página ${page} de ${totalPages}`} />}
              {showColumns && <ColumnManager columns={columns} onChange={setColumns} />}
            </div>
          )}
          <footer className="explorer-footer">
            <span>Mostrando {result.data.length} de {result.total.toLocaleString('es')}</span>
            <div>
              <button className="row-action" type="button" disabled={result.offset === 0 || isRunning} onClick={() => void run(Math.max(0, result.offset - result.limit), payload)}>Anterior</button>
              <button className="row-action" type="button" disabled={result.offset + result.limit >= result.total || isRunning} onClick={() => void run(result.offset + result.limit, payload)}>Siguiente</button>
            </div>
          </footer>
          {isExportOpen && outputPayload && <ExportModal payload={outputPayload} total={result.total} onClose={() => setIsExportOpen(false)} />}
          {isSaveOpen && outputPayload && <SaveQueryModal definition={outputPayload} columns={visibleColumns.length} onClose={() => setIsSaveOpen(false)} />}
        </section>
      )}
    </section>
  );
}
