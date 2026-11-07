'use client';

import { useCallback, useState } from 'react';
import { Modal } from '@/components/app-shell/modal';
import { PageHeader } from '@/components/app-shell/page-header';
import { EVENT_LABELS, eventLabel, IMPACT_VIEW } from '@/components/audit/audit-labels';
import { Icon } from '@/components/icons';
import { apiBaseUrl, type ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useApiQuery } from '@/lib/api/use-api-query';
import { useAuth } from '@/lib/auth-context';
import type { components, paths } from '@/lib/api/schema';

type Entry = components['schemas']['AuditLogEntryResponseDto'];
type Impact = Entry['impacto'];
type EventType = NonNullable<NonNullable<paths['/audit/logs']['get']['parameters']['query']>['tipoAccion']>;
type Filters = { desde: string; hasta: string; tipo: EventType | ''; impacto: Impact | ''; buscar: string };

const EMPTY: Filters = { desde: '', hasta: '', tipo: '', impacto: '', buscar: '' };
const dateTime = (value: string) => new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
const startOfDay = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const endOfDay = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();

function parseDetails(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Bitácora de auditoría e inspector de eventos (#47, backend #66). ADMIN y AUDITOR. */
export default function AuditPage() {
  const call = useApiCall();
  const { session, refreshSession } = useAuth();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [inspected, setInspected] = useState<Entry | null>(null);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const query = useCallback(() => ({
    page,
    limit: 25,
    ...(filters.desde ? { fechaInicio: startOfDay(filters.desde) } : {}),
    ...(filters.hasta ? { fechaFin: endOfDay(filters.hasta) } : {}),
    ...(filters.tipo ? { tipoAccion: filters.tipo } : {}),
    ...(filters.impacto ? { impacto: filters.impacto } : {}),
    ...(filters.buscar.trim() ? { buscar: filters.buscar.trim() } : {}),
  }), [filters, page]);

  const logs = useApiQuery(useCallback((api: ApiClient) => api.GET('/audit/logs', { params: { query: query() } }), [query]));
  const summary = useApiQuery(useCallback((api: ApiClient) => api.GET('/audit/summary', { params: { query: { dias: '30' } } }), []));

  async function inspect(entry: Entry) {
    setCopied(false);
    setInspected(entry);
    // El detalle se vuelve a pedir al servidor: el inspector es de solo lectura y siempre muestra lo registrado.
    const result = await call((api) => api.GET('/audit/logs/{id}', { params: { path: { id: entry.id } } })).catch(() => null);
    if (result?.response.ok && result.data) setInspected(result.data);
  }

  async function exportLogs(format: 'csv' | 'json') {
    if (!session) return;
    setExporting(true);
    setExportError(null);
    const { page: _page, limit: _limit, ...rest } = query();
    const params = new URLSearchParams({ ...Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, String(value)])), format });
    const send = (token: string) => fetch(`${apiBaseUrl}/audit/logs/export?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    try {
      let response = await send(session.accessToken);
      if (response.status === 401) {
        const renewed = await refreshSession();
        if (!renewed) return;
        response = await send(renewed);
      }
      if (!response.ok) {
        setExportError(apiErrorMessage(await response.json().catch(() => null), response.status));
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `bitacora-${new Date().toISOString().slice(0, 10)}.${format}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportError(NETWORK_ERROR_MESSAGE);
    } finally {
      setExporting(false);
    }
  }

  const data = logs.data;
  const details = inspected ? parseDetails(inspected.detailsJson) : null;
  const payload = inspected ? JSON.stringify({ evento: inspected.eventType, resultado: inspected.outcome, recurso: inspected.targetType ? { tipo: inspected.targetType, id: inspected.targetId } : null, detalles: details }, null, 2) : '';

  return (
    <>
      <PageHeader
        trail={['Administración', 'Auditoría']}
        title="Bitácora de auditoría"
        subtitle="Registro inmutable de accesos, cambios de configuración y operaciones sobre los datos."
        actions={
          <>
            <button className="button form-secondary page-action" type="button" disabled={exporting} onClick={() => void exportLogs('json')}><Icon name="file" size={14} />JSON</button>
            <button className="button button--primary page-action" type="button" disabled={exporting} onClick={() => void exportLogs('csv')}><Icon name="arrow-up-right" size={14} />{exporting ? 'Exportando…' : 'Exportar bitácora'}</button>
          </>
        }
      />

      <section className="kpi-grid" aria-label="Métricas de los últimos 30 días">
        {[
          { title: 'Eventos (30 días)', value: summary.data?.eventos, icon: 'activity' as const, footer: `${summary.data?.fallos ?? 0} con resultado fallido` },
          { title: 'Usuarios con actividad', value: summary.data?.usuariosActivos, icon: 'users' as const, footer: 'Distintos en el período' },
          { title: 'Impacto alto', value: summary.data?.porImpacto.ALTO, icon: 'alert' as const, footer: `${summary.data?.porImpacto.MEDIO ?? 0} de impacto medio` },
          { title: 'Retención', value: summary.data ? `${summary.data.retencionDias} días` : undefined, icon: 'lock' as const, footer: 'Registros inmutables' },
        ].map((kpi) => (
          <article className="surface-card kpi-card" key={kpi.title}>
            <header><span>{kpi.title}</span><Icon name={kpi.icon} size={16} /></header>
            <p className="kpi-value">{kpi.value ?? '—'}</p>
            <footer><span>{kpi.footer}</span></footer>
          </article>
        ))}
      </section>

      {exportError && <p className="form-error page-notice" role="alert">{exportError}</p>}

      <section className="surface-card data-card team-card" aria-labelledby="audit-title">
        <form className="filter-bar audit-filter-bar" onSubmit={(event) => { event.preventDefault(); setPage(1); setFilters(draft); }}>
          <label><span>Desde</span><input className="form-input" type="date" value={draft.desde} max={draft.hasta || undefined} onChange={(event) => setDraft({ ...draft, desde: event.target.value })} /></label>
          <label><span>Hasta</span><input className="form-input" type="date" value={draft.hasta} min={draft.desde || undefined} onChange={(event) => setDraft({ ...draft, hasta: event.target.value })} /></label>
          <select className="form-input" value={draft.tipo} onChange={(event) => setDraft({ ...draft, tipo: event.target.value as EventType | '' })} aria-label="Acción">
            <option value="">Todas las acciones</option>
            {Object.entries(EVENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className="form-input" value={draft.impacto} onChange={(event) => setDraft({ ...draft, impacto: event.target.value as Impact | '' })} aria-label="Impacto">
            <option value="">Cualquier impacto</option>
            {(Object.keys(IMPACT_VIEW) as Impact[]).map((value) => <option key={value} value={value}>Impacto {IMPACT_VIEW[value].label.toLowerCase()}</option>)}
          </select>
          <input className="form-input" placeholder="Usuario, IP o recurso" value={draft.buscar} onChange={(event) => setDraft({ ...draft, buscar: event.target.value })} aria-label="Buscar por usuario o IP" />
          <button className="button button--primary" type="submit">Aplicar</button>
          <button className="button form-secondary" type="button" onClick={() => { setDraft(EMPTY); setFilters(EMPTY); setPage(1); }}>Limpiar</button>
        </form>
        <h2 id="audit-title" className="visually-hidden">Eventos</h2>
        {logs.error && !data ? (
          <p className="form-error page-notice">{logs.error}</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Fecha y hora</th><th>Usuario</th><th>Acción</th><th>Recurso</th><th>IP</th><th>Impacto</th><th>Resultado</th><th><span className="visually-hidden">Inspeccionar</span></th></tr></thead>
              <tbody>
                {(data?.data ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <td className="cell-mono">{dateTime(entry.createdAt)}<small className="cell-sub">{entry.id.slice(0, 8)}</small></td>
                    <td>{entry.actorEmail ?? 'Sistema'}</td>
                    <td><strong>{eventLabel(entry.eventType)}</strong><small className="cell-sub cell-mono">{entry.eventType}</small></td>
                    <td>{entry.targetType ? <>{entry.targetType}<small className="cell-sub cell-mono">{entry.targetId?.slice(0, 18)}</small></> : '—'}</td>
                    <td className="cell-mono">{entry.ipAddress ?? '—'}</td>
                    <td><span className="status-pill" data-tone={IMPACT_VIEW[entry.impacto].tone}><i />{IMPACT_VIEW[entry.impacto].label}</span></td>
                    <td><span className="status-pill" data-tone={entry.outcome === 'SUCCESS' ? 'ok' : 'error'}><i />{entry.outcome === 'SUCCESS' ? 'Correcto' : 'Fallido'}</span></td>
                    <td className="cell-actions"><button className="row-action" type="button" onClick={() => void inspect(entry)}>Inspeccionar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {logs.isLoading && <p className="page-message">Cargando eventos…</p>}
            {data && data.total === 0 && <p className="page-message">No hay eventos con estos filtros.</p>}
          </div>
        )}
        <footer className="explorer-footer">
          <span>{data ? `${data.total.toLocaleString('es')} eventos · página ${data.page} de ${Math.max(1, data.totalPages)}` : ''}</span>
          <div>
            <button className="row-action" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button>
            <button className="row-action" type="button" disabled={!data || page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Siguiente</button>
          </div>
        </footer>
      </section>

      {inspected && (
        <Modal
          size="lg"
          title="Inspector de evento"
          description={`${eventLabel(inspected.eventType)} · ${dateTime(inspected.createdAt)}`}
          onClose={() => setInspected(null)}
          footer={<button className="button form-secondary" type="button" onClick={() => setInspected(null)}>Cerrar</button>}
        >
          <dl className="inspector-grid">
            <div><dt>Usuario</dt><dd>{inspected.actorEmail ?? 'Sistema'}</dd></div>
            <div><dt>ID del evento</dt><dd className="cell-mono">{inspected.id}</dd></div>
            <div><dt>IP</dt><dd className="cell-mono">{inspected.ipAddress ?? '—'}</dd></div>
            <div><dt>Fecha (UTC)</dt><dd className="cell-mono">{inspected.createdAt}</dd></div>
            <div><dt>Impacto</dt><dd><span className="status-pill" data-tone={IMPACT_VIEW[inspected.impacto].tone}><i />{IMPACT_VIEW[inspected.impacto].label}</span></dd></div>
            <div><dt>Resultado</dt><dd><span className="status-pill" data-tone={inspected.outcome === 'SUCCESS' ? 'ok' : 'error'}><i />{inspected.outcome === 'SUCCESS' ? 'Correcto' : 'Fallido'}</span></dd></div>
            <div className="inspector-wide"><dt>Navegador</dt><dd className="cell-mono">{inspected.userAgent ?? '—'}</dd></div>
          </dl>
          <div className="inspector-payload">
            <header><strong>Payload</strong><button className="row-action" type="button" onClick={() => void navigator.clipboard.writeText(payload).then(() => setCopied(true))}>{copied ? 'Copiado' : 'Copiar JSON'}</button></header>
            <pre className="json-view">{payload}</pre>
          </div>
          <p className="field-help"><Icon name="shield" size={11} /> Registro inmutable. El payload nunca incluye contraseñas, credenciales ni tokens.</p>
        </Modal>
      )}
    </>
  );
}
