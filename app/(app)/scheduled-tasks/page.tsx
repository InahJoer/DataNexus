'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { Modal } from '@/components/app-shell/modal';
import { PageHeader } from '@/components/app-shell/page-header';
import { StatusView } from '@/components/app-shell/status-view';
import { Icon } from '@/components/icons';
import { ScheduleForm } from '@/components/reports/schedule-form';
import { asText, dateTime, describeFrequency, FORMAT_LABELS, relative, STATUS_VIEW, type Schedule } from '@/components/reports/report-helpers';
import type { ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useApiQuery } from '@/lib/api/use-api-query';

type Dialog = { kind: 'form'; schedule?: Schedule } | { kind: 'delete'; schedule: Schedule } | null;

/** Tareas programadas (#70): reportes automáticos de consultas guardadas. */
export default function ScheduledTasksPage() {
  const call = useApiCall();
  const schedules = useApiQuery(useCallback((api: ApiClient) => api.GET('/reports/schedules'), []));
  const summary = useApiQuery(useCallback((api: ApiClient) => api.GET('/reports/schedules/summary'), []));
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Schedule['status'] | ''>('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const reload = () => {
    void schedules.reload();
    void summary.reload();
  };

  const list = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (schedules.data ?? []).filter((item) =>
      (!status || item.status === status) && (!term || `${item.reportTitle} ${item.savedQueryName}`.toLowerCase().includes(term)),
    );
  }, [schedules.data, search, status]);

  async function act(
    key: string,
    action: () => Promise<{ response: Response; error?: unknown; data?: { status?: string; error?: unknown } }>,
    success: string,
  ) {
    setBusy(key);
    setNotice(null);
    try {
      const result = await action();
      if (!result.response.ok) {
        setNotice({ tone: 'error', text: apiErrorMessage(result.error, result.response.status) });
        return false;
      }
      reload();
      if (result.data?.status === 'FAILED') {
        setNotice({ tone: 'error', text: asText(result.data.error) ?? 'La ejecución falló. Revisa el historial en Ejecuciones.' });
        return false;
      }
      setNotice({ tone: 'ok', text: success });
      return true;
    } catch {
      setNotice({ tone: 'error', text: NETWORK_ERROR_MESSAGE });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const data = schedules.data ?? [];
  const lastOk = data.filter((item) => item.status !== 'ERROR' && asText(item.lastRunAt)).sort((a, b) => String(b.lastRunAt).localeCompare(String(a.lastRunAt)))[0];
  const failing = data.find((item) => item.status === 'ERROR');
  const next = asText(summary.data?.nextExecutionAt);

  return (
    <>
      <PageHeader
        trail={['Workspace', 'Automatización']}
        title="Tareas programadas"
        subtitle="Reportes que se generan y se envían solos a partir de tus consultas guardadas."
        actions={
          <>
            <button className="shell-icon-button" type="button" aria-label="Actualizar" onClick={reload}><Icon name="refresh" size={15} /></button>
            <button className="button button--primary page-action" type="button" onClick={() => setDialog({ kind: 'form' })}><Icon name="clock" size={14} />Nueva tarea</button>
          </>
        }
      />

      <section className="kpi-grid" aria-label="Resumen de tareas">
        {[
          { title: 'Tareas activas', value: String(summary.data?.active ?? '—'), icon: 'clock' as const, footer: `${summary.data?.paused ?? 0} pausadas` },
          { title: 'Con error', value: String(summary.data?.error ?? '—'), icon: 'alert' as const, footer: summary.data?.error ? 'Revisa el detalle abajo' : 'Todo en orden' },
          { title: 'Ejecuciones de hoy', value: String(summary.data?.executionsToday ?? '—'), icon: 'activity' as const, footer: 'Programadas y manuales' },
          { title: 'Próxima ejecución', value: next ? new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(next)) : '—', icon: 'calendar' as const, footer: next ? `${dateTime(next)} (${relative(next)})` : 'Sin tareas activas' },
        ].map((kpi) => (
          <article className="surface-card kpi-card" key={kpi.title}>
            <header><span>{kpi.title}</span><Icon name={kpi.icon} size={16} /></header>
            <p className="kpi-value">{kpi.value}</p>
            <footer><span>{kpi.footer}</span></footer>
          </article>
        ))}
      </section>

      {notice && <p className={notice.tone === 'ok' ? 'page-notice' : 'form-error page-notice'} role="status">{notice.text}</p>}

      {schedules.error && !schedules.data ? (
        <StatusView tone="error" icon="alert" title="No se pudieron cargar las tareas" description={schedules.error} action={{ label: 'Reintentar', onClick: reload }} />
      ) : !schedules.isLoading && data.length === 0 ? (
        <StatusView icon="clock" title="Aún no hay tareas programadas" description="Guarda una consulta en el Editor de consultas y prográmala para recibir el reporte por correo cada día, semana o mes." action={{ label: 'Nueva tarea', onClick: () => setDialog({ kind: 'form' }) }} />
      ) : (
        <section className="surface-card data-card team-card" aria-labelledby="tasks-title">
          <header className="data-card-header">
            <h2 id="tasks-title">Tareas</h2>
            <label className="search-field"><Icon name="search" size={14} /><input type="search" placeholder="Buscar tarea o consulta" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Buscar tareas" /></label>
            <select className="form-input compact-select" value={status} onChange={(event) => setStatus(event.target.value as Schedule['status'] | '')} aria-label="Filtrar por estado">
              <option value="">Todos los estados</option>
              {(Object.keys(STATUS_VIEW) as Schedule['status'][]).map((value) => <option key={value} value={value}>{STATUS_VIEW[value].label}</option>)}
            </select>
          </header>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Tarea</th><th>Estado</th><th>Frecuencia</th><th>Última</th><th>Próxima</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
              <tbody>
                {list.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.reportTitle}</strong><small className="cell-sub">{item.savedQueryName} · {FORMAT_LABELS[item.format]}{item.sendEmail ? ` · ${item.recipients.length || 1} destinatario(s)` : ' · sin correo'}</small></td>
                    <td><span className="status-pill" data-tone={STATUS_VIEW[item.status].tone}><i />{STATUS_VIEW[item.status].label}</span></td>
                    <td>{describeFrequency(item)}<small className="cell-sub cell-mono">{item.cronExpression} · {item.timezone}</small></td>
                    <td>{dateTime(item.lastRunAt)}</td>
                    <td>{item.status === 'PAUSED' ? '—' : dateTime(item.nextRunAt)}<small className="cell-sub">{item.status === 'PAUSED' ? '' : relative(item.nextRunAt)}</small></td>
                    <td className="cell-actions">
                      <button className="row-action" type="button" disabled={busy === `run-${item.id}`} onClick={() => void act(`run-${item.id}`, () => call((api) => api.POST('/reports/schedules/{id}/run', { params: { path: { id: item.id } } })), `"${item.reportTitle}" se ejecutó ahora. Revisa el resultado en Ejecuciones.`)}>{busy === `run-${item.id}` ? 'Ejecutando…' : 'Ejecutar ahora'}</button>
                      {item.status === 'PAUSED'
                        ? <button className="row-action" type="button" disabled={busy === `res-${item.id}`} onClick={() => void act(`res-${item.id}`, () => call((api) => api.POST('/reports/schedules/{id}/resume', { params: { path: { id: item.id } } })), 'Tarea reanudada.')}>Reanudar</button>
                        : <button className="row-action" type="button" disabled={busy === `pau-${item.id}`} onClick={() => void act(`pau-${item.id}`, () => call((api) => api.POST('/reports/schedules/{id}/pause', { params: { path: { id: item.id } } })), 'Tarea pausada.')}>Pausar</button>}
                      <button className="row-action" type="button" onClick={() => setDialog({ kind: 'form', schedule: item })}>Editar</button>
                      <Link className="row-action" href={`/executions?tarea=${item.id}`}>Historial</Link>
                      <button className="row-action row-action--danger" type="button" onClick={() => setDialog({ kind: 'delete', schedule: item })}>Eliminar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(lastOk || failing) && (
        <div className="panel-grid">
          {lastOk && (
            <section className="surface-card panel-card"><header className="panel-header"><div><h2>Último envío completado</h2><p>{lastOk.reportTitle}</p></div><span className="status-pill" data-tone="ok"><i />OK</span></header><p className="panel-note">{dateTime(lastOk.lastRunAt)} · {FORMAT_LABELS[lastOk.format]} · {describeFrequency(lastOk)}</p></section>
          )}
          {failing && (
            <section className="surface-card panel-card"><header className="panel-header"><div><h2>Tarea con error</h2><p>{failing.reportTitle}</p></div><span className="status-pill" data-tone="error"><i />Error</span></header><div className="env-alert"><Icon name="alert" size={15} /><div><strong>{asText(failing.lastError) ?? 'La última ejecución falló'}</strong><Link href={`/executions?tarea=${failing.id}`}>Ver historial <Icon name="arrow-right" size={12} /></Link></div></div></section>
          )}
        </div>
      )}

      {dialog?.kind === 'form' && <ScheduleForm schedule={dialog.schedule} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setNotice({ tone: 'ok', text: 'Tarea guardada.' }); reload(); }} />}
      {dialog?.kind === 'delete' && (
        <Modal
          title="Eliminar tarea"
          description={`"${dialog.schedule.reportTitle}" dejará de ejecutarse. El historial de ejecuciones se conserva.`}
          onClose={() => setDialog(null)}
          footer={<><button className="button form-secondary" type="button" onClick={() => setDialog(null)}>Cancelar</button><button className="button form-danger" type="button" disabled={busy === 'delete'} onClick={() => void act('delete', () => call((api) => api.DELETE('/reports/schedules/{id}', { params: { path: { id: dialog.schedule.id } } })), 'Tarea eliminada.').then((ok) => ok && setDialog(null))}>Eliminar</button></>}
        >
          <p className="modal-text">La consulta guardada no se borra; puedes volver a programarla cuando quieras.</p>
        </Modal>
      )}
    </>
  );
}
