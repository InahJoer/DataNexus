'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell/page-header';
import { StatusView } from '@/components/app-shell/status-view';
import { DataView } from '@/components/explorer/data-view';
import { ExplorerTree, type CatalogObject, type ExplorerTarget, type SchemaState } from '@/components/explorer/explorer-tree';
import { Icon } from '@/components/icons';
import type { ApiClient } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/use-api-query';

/** Explorador de datos (estilo Firefoo) para todas las conexiones: SQL, MongoDB y Firestore con sus subcolecciones. */
export default function ExplorerPage() {
  const connections = useApiQuery(useCallback((api: ApiClient) => api.GET('/connections'), []));
  const [target, setTarget] = useState<ExplorerTarget | null>(null);
  const [schemas, setSchemas] = useState<Record<string, SchemaState>>({});

  // Subcolecciones conocidas de la colección abierta (las descubre el backend como padre/*/sub).
  const subcollections = useMemo(() => {
    if (!target) return [];
    const schema = schemas[target.connection.id];
    if (schema?.state !== 'ready') return [];
    const prefix = `${target.object.name}/*/`;
    return schema.objects.filter((object) => object.name.startsWith(prefix)).map((object) => object.name.slice(prefix.length));
  }, [schemas, target]);

  const open = useCallback(
    (object: CatalogObject) => setTarget((current) => (current ? { connection: current.connection, object } : current)),
    [],
  );

  return (
    <>
      <PageHeader
        trail={['Workspace', 'Explorador']}
        title="Explorador de datos"
        subtitle="Navega tablas, colecciones y subcolecciones de todas tus conexiones; filtra, revisa documentos y edita celdas."
      />
      <nav className="page-notice" aria-label="Vistas de consultas">
        <Link className="auth-link" href="/queries">Query Builder</Link>
        {' · '}
        <span aria-current="page">Vista tabular con filtros</span>
      </nav>
      {connections.isLoading ? (
        <p className="page-message">Cargando conexiones…</p>
      ) : connections.error && !connections.data ? (
        <StatusView tone="error" icon="alert" title="No se pudieron cargar las conexiones" description={connections.error} action={{ label: 'Reintentar', onClick: () => void connections.reload() }} />
      ) : !connections.data?.length ? (
        <StatusView icon="database" title="Aún no hay conexiones" description="Agrega una conexión SQL o NoSQL para explorar sus datos." action={{ label: 'Ir a Conexiones', href: '/connections' }} />
      ) : (
        <div className="explorer surface-card">
          <ExplorerTree connections={connections.data} selected={target} onSelect={setTarget} schemas={schemas} setSchemas={setSchemas} />
          {target ? (
            <DataView key={`${target.connection.id}:${target.object.schema ?? ''}:${target.object.name}`} target={target} subcollections={subcollections} onOpen={open} />
          ) : (
            <div className="explorer-empty">
              <Icon name="table" size={22} />
              <p>Abre una conexión a la izquierda y elige una tabla o colección para ver sus datos.</p>
              <Link className="auth-link" href="/queries">¿Quieres combinar varias fuentes? Abre el editor de consultas</Link>
            </div>
          )}
        </div>
      )}
    </>
  );
}
