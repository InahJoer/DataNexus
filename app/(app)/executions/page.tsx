'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/app-shell/page-header';
import { StatusView } from '@/components/app-shell/status-view';
import { Icon } from '@/components/icons';
import {
  asNumber,
  asText,
  dateTime,
  EXECUTION_STATUS,
  formatDuration,
  formatSize,
  TRIGGER_LABELS,
  type Execution,
} from '@/components/reports/report-helpers';
import type { ApiClient } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/use-api-query';

/** Historial de ejecuciones de reportes: estado, duración, tamaño, filas, intentos y descarga. */
function ExecutionsView() {
  const scheduleId = useSearchParams().get('tarea');
  const [status, setStatus] = useState<Execution['status'] | ''>('');
  const [trigger, setTrigger] = useState<Execution['trigger'] | ''>('');
  const executions = useApiQuery(
    useCallback(
      (api: ApiClient) => {
        const query = { limit: 100, ...(status ? { status } : {}), ...(trigger ? { trigger } : {}) };
        return scheduleId
          ? api.GET('/reports/schedules/{id}/executions', { params: { path: { id: scheduleId }, query } })
          : api.GET('/reports/executions', { params: { query } });
      },
      [scheduleId, status, trigger],
    ),
    { refreshMs: 30_000 },
  );
  const rows = executions.data ?? [];

  const stats = useMemo(() => {
    const done = rows.filter((row) => row.status !== 'RUNNING');
    const ok = rows.filter((row) => row.status === 'SUCCEEDED').length;
    const durations = done.map((row) => asNumber(row.durationMs)).filter((value): value is number => value !== null);
    return {
      total: rows.length,
      rate: done.length ? Math.round((ok / done.length) * 100) : null,
      failed: rows.filter((row) => row.status === 'FAILED').length,
      avg: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    };
  }, [rows]);

  return (
    <>
      <PageHeader
        trail={['Workspace', 'Ejecuciones']}
        title="Ejecuciones"
        subtitle={scheduleId ? 'Historial de una tarea programada.' : 'Cada reporte generado: programado, ejecutado a mano o a pedido.'}
        actions={<button className="shell-icon-button" type="button" aria-label="Actualizar" onClick={() => void executions.reload()}><Icon name="refresh" size={15} /></button>}
      />
      <section className="kpi-grid" aria-label="Resumen de ejecuciones">
        {[
          { title: 'Ejecuciones', value: String(stats.total), icon: 'activity' as const, footer: 'Últimas 100' },
          { title: 'Tasa de éxito', value: stats.rate === null ? '—' : `${stats.rate}%`, icon: 'check' as const, footer: 'Sin contar las que siguen en curso' },
          { title: 'Fallidas', value: String(stats.failed), icon: 'alert' as const, footer: stats.failed ? 'Se reintentan con espera creciente' : 'Sin fallos' },
          { title: 'Duración media', value: formatDuration(stats.avg), icon: 'clock' as const, footer: 'Desde la consulta hasta el envío' },
        ].map((kpi) => (
          <article className="surface-card kpi-card" key={kpi.title}>
            <header><span>{kpi.title}</span><Icon name={kpi.icon} size={16} /></header>
            <p className="kpi-value">{kpi.value}</p>
            <footer><span>{kpi.footer}</span></footer>
          </article>
        ))}
      </section>

      <section className="surface-card data-card team-card" aria-labelledby="executions-title">
        <header className="data-card-header">
          <h2 id="executions-title">Historial</h2>
          <select className="form-input compact-select" value={status} onChange={(event) => setStatus(event.target.value as Execution['status'] | '')} aria-label="Filtrar por estado">
            <option value="">Todos los estados</option>
            {(Object.keys(EXECUTION_STATUS) as Execution['status'][]).map((value) => <option key={value} value={value}>{EXECUTION_STATUS[value].label}</option>)}
          </select>
          <select className="form-input compact-select" value={trigger} onChange={(event) => setTrigger(event.target.value as Execution['trigger'] | '')} aria-label="Filtrar por origen">
            <option value="">Todos los orígenes</option>
            {(Object.keys(TRIGGER_LABELS) as Execution['trigger'][]).map((value) => <option key={value} value={value}>{TRIGGER_LABELS[value]}</option>)}
          </select>
        </header>
        {executions.error && !executions.data ? (
          <p className="form-error page-notice">{executions.error}</p>
        ) : rows.length === 0 ? (
          <StatusView icon="activity" title={executions.isLoading ? 'Cargando…' : 'Sin ejecuciones todavía'} description="Cuando una tarea se ejecute (o pulses Ejecutar ahora), aparecerá aquí con su resultado." />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Inicio</th><th>Reporte</th><th>Origen</th><th>Estado</th><th>Duración</th><th>Filas</th><th>Tamaño</th><th>Intentos</th><th><span className="visually-hidden">Descarga</span></th></tr></thead>
              <tbody>
                {rows.map((row) => {
                  const view = EXECUTION_STATUS[row.status];
                  const download = asText(row.downloadUrl);
                  return (
                    <tr key={row.id}>
                      <td>{dateTime(row.startedAt)}</td>
                      <td><strong>{asText(row.titulo) ?? 'Reporte'}</strong><small className="cell-sub">{(asText(row.formato) ?? '').toUpperCase()}</small></td>
                      <td>{TRIGGER_LABELS[row.trigger]}</td>
                      <td><span className="status-pill" data-tone={view.tone}><i />{view.label}</span>{asText(row.error) && <small className="cell-sub" data-tone="error" title={asText(row.error) ?? undefined}>{asText(row.error)?.slice(0, 80)}</small>}</td>
                      <td>{formatDuration(row.durationMs)}</td>
                      <td>{asNumber(row.totalRows)?.toLocaleString('es') ?? '—'}</td>
                      <td>{formatSize(row.fileSizeBytes)}</td>
                      <td>{row.attempts}</td>
                      <td className="cell-actions">{download && <a className="row-action" href={download} target="_blank" rel="noreferrer">Descargar</a>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export default function ExecutionsPage() {
  return <Suspense fallback={<p className="page-message">Cargando…</p>}><ExecutionsView /></Suspense>;
}
