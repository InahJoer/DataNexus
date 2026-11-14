'use client';

import { useState } from 'react';
import { ENGINES, type Connection, type DataSource } from '@/components/connections/engines';
import { Icon } from '@/components/icons';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import type { components } from '@/lib/api/schema';

export type CatalogObject = components['schemas']['CatalogObjectResponseDto'];
/** Tabla o colección abierta: de una conexión o una hoja de un archivo de Excel. */
export type ExplorerTarget = Readonly<{ connection: DataSource; object: CatalogObject }>;

type SchemaState = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; objects: CatalogObject[] };

/** Etiqueta del objeto: esquema.tabla en SQL; en Firestore, las subcolecciones (padre/*\/sub) se muestran como "sub". */
export function objectLabel(object: CatalogObject) {
  if (object.name.includes('/*/')) return object.name.split('/*/')[1];
  // En MongoDB el "esquema" es la base de la conexión: no aporta nada mostrarlo.
  const showSchema = object.type !== 'COLLECTION' && object.schema && object.schema !== 'public' && object.schema !== 'dbo';
  return showSchema ? `${object.schema}.${object.name}` : object.name;
}

type ExplorerTreeProps = Readonly<{
  connections: Connection[];
  selected: ExplorerTarget | null;
  onSelect: (target: ExplorerTarget) => void;
  /** Catálogos ya cargados, compartidos con la página (subcolecciones disponibles en el panel del documento). */
  schemas: Record<string, SchemaState>;
  setSchemas: (update: (current: Record<string, SchemaState>) => Record<string, SchemaState>) => void;
}>;

/** Árbol de la izquierda (estilo Firefoo): conexiones → tablas o colecciones → subcolecciones. */
export function ExplorerTree({ connections, selected, onSelect, schemas, setSchemas }: ExplorerTreeProps) {
  const call = useApiCall();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');

  async function loadSchema(connection: Connection, force = false) {
    if (!force && schemas[connection.id]?.state === 'ready') return;
    setSchemas((current) => ({ ...current, [connection.id]: { state: 'loading' } }));
    try {
      const result = await call((api) =>
        api.GET('/engine/connections/{connectionId}/schema', { params: { path: { connectionId: connection.id } } }),
      );
      setSchemas((current) => ({
        ...current,
        [connection.id]: result.response.ok && result.data
          ? { state: 'ready', objects: result.data.objects }
          : { state: 'error', message: apiErrorMessage(result.error, result.response.status) },
      }));
    } catch {
      setSchemas((current) => ({ ...current, [connection.id]: { state: 'error', message: NETWORK_ERROR_MESSAGE } }));
    }
  }

  function toggle(connection: Connection) {
    const next = !open[connection.id];
    setOpen((current) => ({ ...current, [connection.id]: next }));
    if (next) void loadSchema(connection);
  }

  const term = filter.trim().toLowerCase();
  const isSelected = (connection: Connection, object: CatalogObject) =>
    selected?.connection.id === connection.id && selected.object.name === object.name && selected.object.schema === object.schema;

  function renderObject(connection: Connection, object: CatalogObject, children: CatalogObject[]) {
    return (
      <li key={`${object.schema ?? ''}.${object.name}`}>
        <button
          type="button"
          className="tree-item"
          aria-current={isSelected(connection, object) ? 'true' : undefined}
          onClick={() => onSelect({ connection, object })}
          title={object.name}
        >
          <Icon name={object.type === 'COLLECTION' ? 'folder' : 'table'} size={14} />
          <span>{objectLabel(object)}</span>
          {object.type === 'VIEW' && <small>vista</small>}
          {object.name.includes('/*/') && <small>subcolección</small>}
        </button>
        {children.length > 0 && <ul className="tree-children">{children.map((child) => renderObject(connection, child, []))}</ul>}
      </li>
    );
  }

  return (
    <nav className="explorer-tree" aria-label="Conexiones y colecciones">
      <label className="search-field tree-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="Buscar tabla o colección" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Buscar en el árbol" />
      </label>
      <ul className="tree-root">
        {connections.map((connection) => {
          const schema = schemas[connection.id];
          const objects = schema?.state === 'ready' ? schema.objects : [];
          const roots = objects.filter((object) => !object.name.includes('/*/'));
          const childrenOf = (object: CatalogObject) => objects.filter((child) => child.name.startsWith(`${object.name}/*/`));
          const visibleRoots = term
            ? roots.filter((object) => [object, ...childrenOf(object)].some((item) => item.name.toLowerCase().includes(term)))
            : roots;
          const isOpen = open[connection.id] || Boolean(term && schema?.state === 'ready');
          return (
            <li key={connection.id}>
              <button type="button" className="tree-connection" aria-expanded={isOpen} onClick={() => toggle(connection)}>
                <Icon name="chevron-right" size={13} className={isOpen ? 'tree-caret tree-caret--open' : 'tree-caret'} />
                <span className="engine-badge" data-engine={connection.tipoMotor}>{ENGINES[connection.tipoMotor].short}</span>
                <span className="tree-connection-name">{connection.nombre ?? connection.dbName}<small>{ENGINES[connection.tipoMotor].label}</small></span>
              </button>
              {isOpen && (
                <div className="tree-branch">
                  {schema?.state === 'loading' && <p className="tree-note">Cargando…</p>}
                  {schema?.state === 'error' && (
                    <p className="tree-note tree-note--error">{schema.message} <button type="button" onClick={() => void loadSchema(connection, true)}>Reintentar</button></p>
                  )}
                  {schema?.state === 'ready' && visibleRoots.length === 0 && <p className="tree-note">{term ? 'Sin coincidencias' : 'Sin tablas ni colecciones'}</p>}
                  {schema?.state === 'ready' && <ul className="tree-children">{visibleRoots.map((object) => renderObject(connection, object, childrenOf(object)))}</ul>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export type { SchemaState };
