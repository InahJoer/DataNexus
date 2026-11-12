'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell/page-header';
import { StatusView } from '@/components/app-shell/status-view';
import { DataView } from '@/components/explorer/data-view';
import { ExcelLibrary, ExcelTree, useExcelProcessingRefresh } from '@/components/explorer/excel-library';
import { ExplorerTree, type CatalogObject, type ExplorerTarget, type SchemaState } from '@/components/explorer/explorer-tree';
import { Icon } from '@/components/icons';
import type { ApiClient } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/use-api-query';

type Tab = 'databases' | 'excel';
const TAB_KEY = 'datanexus:explorer:tab';

/** Explorador de datos (estilo Firefoo): conexiones SQL, MongoDB y Firestore, y una pestaña propia para los Excels. */
export default function ExplorerPage() {
  const connections = useApiQuery(useCallback((api: ApiClient) => api.GET('/connections'), []));
  const excels = useApiQuery(useCallback((api: ApiClient) => api.GET('/excel'), []));
  const [tab, setTab] = useState<Tab>('databases');
  const [target, setTarget] = useState<ExplorerTarget | null>(null);
  const [excelTarget, setExcelTarget] = useState<ExplorerTarget | null>(null);
  const [schemas, setSchemas] = useState<Record<string, SchemaState>>({});
  // Archivos que se están cargando en el servidor: se refresca su avance hasta que terminan.
  useExcelProcessingRefresh(excels.data, excels.reload);

  // ?vista=excel (enlace del editor de consultas) o la última pestaña usada en este dispositivo.
  useEffect(() => {
    let initial: string | null = new URLSearchParams(window.location.search).get('vista');
    try {
      initial ??= window.localStorage.getItem(TAB_KEY);
    } catch {
      // Sin almacenamiento local: se abre en Bases de datos.
    }
    if (initial === 'excel') setTab('excel');
  }, []);

  function chooseTab(next: Tab) {
    setTab(next);
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {
      // La preferencia es solo una comodidad.
    }
  }

  // Si se elimina o reemplaza el Excel abierto (cambian sus hojas), se vuelve a la biblioteca.
  const excelFiles = useMemo(() => excels.data ?? [], [excels.data]);
  useEffect(() => {
    if (!excelTarget) return;
    const file = excelFiles.find((item) => item.id === excelTarget.connection.id);
    if (!file?.hojas.some((sheet) => sheet.nombre === excelTarget.object.name)) setExcelTarget(null);
  }, [excelFiles, excelTarget]);

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

  const excelCount = excels.data?.length;
  const excelVersion = (id: string) => String(excelFiles.find((file) => file.id === id)?.updatedAt ?? '');

  return (
    <>
      <PageHeader
        trail={['Workspace', 'Explorador']}
        title="Explorador de datos"
        subtitle="Navega tablas, colecciones y subcolecciones de tus conexiones y las hojas de tus archivos de Excel; filtra, revisa y exporta."
      />
      <div className="explorer-tabs">
        <div className="segmented" role="tablist" aria-label="Fuentes del explorador">
          <button type="button" role="tab" aria-selected={tab === 'databases'} aria-pressed={tab === 'databases'} onClick={() => chooseTab('databases')}>
            <Icon name="database" size={13} />Bases de datos{connections.data ? <small>{connections.data.length}</small> : null}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'excel'} aria-pressed={tab === 'excel'} onClick={() => chooseTab('excel')}>
            <Icon name="file" size={13} />Excels{excelCount !== undefined ? <small>{excelCount}</small> : null}
          </button>
        </div>
        <nav className="explorer-tabs-links" aria-label="Vistas de consultas">
          <Link className="auth-link" href="/queries">Combinar fuentes en el editor de consultas</Link>
        </nav>
      </div>

      {tab === 'databases' && (connections.isLoading ? (
        <p className="page-message">Cargando conexiones…</p>
      ) : connections.error && !connections.data ? (
        <StatusView tone="error" icon="alert" title="No se pudieron cargar las conexiones" description={connections.error} action={{ label: 'Reintentar', onClick: () => void connections.reload() }} />
      ) : !connections.data?.length ? (
        <StatusView icon="database" title="Aún no hay conexiones" description="Agrega una conexión SQL o NoSQL para explorar sus datos, o sube un Excel en la pestaña Excels." action={{ label: 'Ir a Conexiones', href: '/connections' }} />
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
      ))}

      {tab === 'excel' && (excels.isLoading ? (
        <p className="page-message">Cargando archivos de Excel…</p>
      ) : excels.error && !excels.data ? (
        <StatusView tone="error" icon="alert" title="No se pudieron cargar los archivos de Excel" description={excels.error} action={{ label: 'Reintentar', onClick: () => void excels.reload() }} />
      ) : (
        <div className="explorer surface-card">
          <ExcelTree files={excelFiles} selected={excelTarget} onSelect={setExcelTarget} onLibrary={() => setExcelTarget(null)} />
          {excelTarget ? (
            <DataView
              key={`${excelTarget.connection.id}:${excelVersion(excelTarget.connection.id)}:${excelTarget.object.name}`}
              target={excelTarget}
              subcollections={[]}
              onOpen={(object) => setExcelTarget((current) => (current ? { connection: current.connection, object } : current))}
            />
          ) : (
            <ExcelLibrary files={excelFiles} onChanged={excels.reload} onOpen={setExcelTarget} />
          )}
        </div>
      ))}
    </>
  );
}
