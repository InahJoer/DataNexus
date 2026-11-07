'use client';

import { useCallback, useMemo, useState } from 'react';
import { Modal } from '@/components/app-shell/modal';
import { PageHeader } from '@/components/app-shell/page-header';
import { StatusView } from '@/components/app-shell/status-view';
import { ConnectionForm } from '@/components/connections/connection-form';
import { ENGINES, type Connection } from '@/components/connections/engines';
import { Icon } from '@/components/icons';
import type { ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useApiQuery } from '@/lib/api/use-api-query';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/permissions';
import { useConnectionHealth } from '@/lib/use-connection-health';

type RowTest = { state: 'running' } | { state: 'ok' | 'error'; detail: string };
type Dialog = { kind: 'create' } | { kind: 'edit'; connection: Connection } | { kind: 'delete'; connection: Connection } | null;

const STATUS: Record<string, { label: string; tone: string }> = {
  HEALTHY: { label: 'Operativa', tone: 'ok' },
  UNAVAILABLE: { label: 'Sin respuesta', tone: 'error' },
  UNSUPPORTED: { label: 'Sin health check', tone: 'muted' },
};

export default function ConnectionsPage() {
  const { session } = useAuth();
  const canManage = hasPermission(session?.user.role, 'MANAGE_CONNECTIONS');
  const call = useApiCall();
  const connections = useApiQuery(useCallback((api: ApiClient) => api.GET('/connections'), []));
  const health = useConnectionHealth();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [tests, setTests] = useState<Record<string, RowTest>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const statusById = useMemo(
    () => new Map((health.report?.connections ?? []).map((item) => [item.connectionId, item])),
    [health.report],
  );
  const list = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (connections.data ?? []).filter((connection) =>
      !term || [connection.nombre, connection.host, connection.dbName, ENGINES[connection.tipoMotor].label].some((value) => value?.toLowerCase().includes(term)),
    );
  }, [connections.data, search]);

  const closeDialog = useCallback(() => setDialog(null), []);
  const afterChange = () => {
    setDialog(null);
    void connections.reload();
    void health.refresh();
  };

  async function testConnection(connection: Connection) {
    setTests((current) => ({ ...current, [connection.id]: { state: 'running' } }));
    try {
      const result = await call((api) => api.POST('/connections/{id}/test', { params: { path: { id: connection.id } }, body: {} }));
      const next: RowTest = !result.response.ok || !result.data
        ? { state: 'error', detail: apiErrorMessage(result.error, result.response.status) }
        : result.data.ok
          ? { state: 'ok', detail: `Responde en ${result.data.latencyMs ?? '—'} ms` }
          : { state: 'error', detail: result.data.error?.message ?? 'No responde' };
      setTests((current) => ({ ...current, [connection.id]: next }));
    } catch {
      setTests((current) => ({ ...current, [connection.id]: { state: 'error', detail: NETWORK_ERROR_MESSAGE } }));
    }
  }

  async function deleteConnection(connection: Connection) {
    setIsDeleting(true);
    setActionError(null);
    try {
      const result = await call((api) => api.DELETE('/connections/{id}', { params: { path: { id: connection.id } } }));
      if (!result.response.ok) {
        setActionError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      afterChange();
    } catch {
      setActionError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsDeleting(false);
    }
  }

  const total = connections.data?.length ?? 0;
  const healthy = (health.report?.connections ?? []).filter((item) => item.status === 'HEALTHY').length;

  return (
    <>
      <PageHeader
        trail={['Workspace', 'Conexiones']}
        title="Conexiones"
        subtitle={total ? `${total} ${total === 1 ? 'fuente conectada' : 'fuentes conectadas'} · ${healthy} operativas en la última comprobación` : 'Bases de datos SQL y NoSQL conectadas a tu workspace.'}
        actions={canManage && <button className="button button--primary page-action" type="button" onClick={() => setDialog({ kind: 'create' })}><Icon name="plug" size={15} />Nueva conexión</button>}
      />

      {connections.isLoading ? (
        <p className="page-message">Cargando conexiones…</p>
      ) : connections.error && !connections.data ? (
        <StatusView tone="error" icon="alert" title="No se pudieron cargar las conexiones" description={connections.error} action={{ label: 'Reintentar', onClick: () => void connections.reload() }} />
      ) : total === 0 ? (
        <StatusView
          icon="database"
          title="Aún no hay conexiones"
          description={canManage ? 'Conecta tu primera base de datos SQL o NoSQL para empezar a cruzar datos.' : 'Un administrador debe agregar las conexiones del workspace.'}
          action={canManage ? { label: 'Nueva conexión', onClick: () => setDialog({ kind: 'create' }) } : undefined}
        />
      ) : (
        <section className="surface-card data-card" aria-labelledby="connections-list-title">
          <header className="data-card-header">
            <h2 id="connections-list-title">Fuentes del workspace</h2>
            <label className="search-field">
              <Icon name="search" size={14} />
              <input type="search" placeholder="Buscar por nombre, motor o host" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Buscar conexiones" />
            </label>
            <button className="shell-icon-button" type="button" onClick={() => void health.refresh()} aria-label="Comprobar estado de todas" disabled={health.isRefreshing}><Icon name="activity" size={15} /></button>
          </header>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Conexión</th><th>Motor</th><th>Host / base</th><th>Estado</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
              <tbody>
                {list.map((connection) => {
                  const engine = ENGINES[connection.tipoMotor];
                  const status = statusById.get(connection.id);
                  const view = status ? STATUS[status.status] : { label: health.isLoading ? 'Comprobando…' : 'Sin comprobar', tone: 'muted' };
                  const test = tests[connection.id];
                  return (
                    <tr key={connection.id}>
                      <td><div className="cell-title"><span className="engine-badge" data-engine={connection.tipoMotor}>{engine.short}</span><strong>{connection.nombre ?? connection.dbName}</strong></div></td>
                      <td>{engine.label}<small className="cell-sub">{engine.family}</small></td>
                      <td className="cell-mono">{connection.host}<small className="cell-sub">{connection.dbName}</small></td>
                      <td>
                        <span className="status-pill" data-tone={view.tone}><i />{view.label}{status?.latencyMs != null && ` · ${status.latencyMs} ms`}</span>
                        {test && <small className="cell-sub" data-tone={test.state === 'running' ? 'muted' : test.state}>{test.state === 'running' ? 'Probando…' : test.detail}</small>}
                      </td>
                      <td className="cell-actions">
                        <button className="row-action" type="button" onClick={() => void testConnection(connection)} disabled={test?.state === 'running'}>Probar</button>
                        {canManage && <button className="row-action" type="button" onClick={() => setDialog({ kind: 'edit', connection })}>Editar</button>}
                        {canManage && <button className="row-action row-action--danger" type="button" onClick={() => { setActionError(null); setDialog({ kind: 'delete', connection }); }}>Eliminar</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {list.length === 0 && <p className="page-message">Ninguna conexión coincide con “{search}”.</p>}
          </div>
        </section>
      )}

      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <ConnectionForm connection={dialog.kind === 'edit' ? dialog.connection : undefined} onClose={closeDialog} onSaved={afterChange} />
      )}
      {dialog?.kind === 'delete' && (
        <Modal
          title="Eliminar conexión"
          description={`Se eliminará “${dialog.connection.nombre ?? dialog.connection.dbName}” y sus credenciales cifradas. Esta acción no se puede deshacer.`}
          onClose={closeDialog}
          footer={
            <>
              <button className="button form-secondary" type="button" onClick={closeDialog}>Cancelar</button>
              <button className="button form-danger" type="button" onClick={() => void deleteConnection(dialog.connection)} disabled={isDeleting}>{isDeleting ? 'Eliminando…' : 'Eliminar'}</button>
            </>
          }
        >
          <p className="modal-text">Las consultas guardadas y reportes que usen esta conexión dejarán de funcionar.</p>
          {actionError && <p className="form-error" role="alert">{actionError}</p>}
        </Modal>
      )}
    </>
  );
}
