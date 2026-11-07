'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatBytes } from '@/components/app-shell/format';
import { PageHeader } from '@/components/app-shell/page-header';
import { StatusView } from '@/components/app-shell/status-view';
import { useWorkspace, type DashboardSummary } from '@/components/app-shell/workspace-context';
import { ENGINES, type Engine } from '@/components/connections/engines';
import { Icon, type IconName } from '@/components/icons';
import { useAuth } from '@/lib/auth-context';

// Algunos campos opcionales llegan tipados de forma imprecisa desde OpenAPI (nullable sin tipo): se leen con cuidado.
const asNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asText = (value: unknown) => (typeof value === 'string' ? value : null);
const fmt = (value: number) => new Intl.NumberFormat('es').format(value);

function relativeTime(iso: string | null) {
  if (!iso) return null;
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' }).format(new Date(iso));
}

function Variation({ value, label }: Readonly<{ value: unknown; label: string }>) {
  const pct = asNumber(value);
  if (pct === null) return <span className="kpi-trend">Sin datos del mes anterior</span>;
  return (
    <span className="kpi-trend" data-tone={pct >= 0 ? 'up' : 'down'}>
      <Icon name="trend-up" size={12} className={pct < 0 ? 'icon-flip' : undefined} />
      {pct > 0 ? '+' : ''}{pct.toLocaleString('es', { maximumFractionDigits: 1 })}% {label}
    </span>
  );
}

function Kpi({ title, icon, value, unit, trend, footer }: Readonly<{ title: string; icon: IconName; value: string; unit?: string; trend: ReactNode; footer: ReactNode }>) {
  return (
    <article className="surface-card kpi-card">
      <header><span>{title}</span><Icon name={icon} size={16} /></header>
      <p className="kpi-value">{value}{unit && <small>{unit}</small>}</p>
      {trend}
      <footer>{footer}</footer>
    </article>
  );
}

function ApiUsageChart({ usage }: Readonly<{ usage: DashboardSummary['consumoApi'] }>) {
  const max = Math.max(1, ...usage.dias.map((day) => day.solicitudes));
  const width = 560;
  const height = 150;
  const step = usage.dias.length > 1 ? width / (usage.dias.length - 1) : width;
  const points = usage.dias.map((day, index) => [index * step, height - (day.solicitudes / max) * (height - 12)] as const);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const dayLabel = (iso: string) => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  return (
    <section className="surface-card panel-card panel-card--wide" aria-labelledby="api-usage-title">
      <header className="panel-header">
        <div><h2 id="api-usage-title">Consumo de API</h2><p>Solicitudes procesadas · últimos 7 días</p></div>
        <span className="panel-chip">Esta semana</span>
      </header>
      <p className="panel-figure">{fmt(usage.totalSemana)} <Variation value={usage.variacionPct} label="vs. semana anterior" /></p>
      <svg className="usage-chart" viewBox={`-8 -8 ${width + 16} ${height + 30}`} role="img" aria-label={`Solicitudes por día: ${usage.dias.map((day) => `${dayLabel(day.dia)} ${day.solicitudes}`).join(', ')}`}>
        <path className="usage-area" d={`${line} L${width} ${height} L0 ${height} Z`} />
        <path className="usage-line" d={line} />
        {points.map(([x, y], index) => <circle key={usage.dias[index].dia} cx={x} cy={y} r="3.5" className="usage-dot" />)}
        {usage.dias.map((day, index) => <text key={day.dia} x={index * step} y={height + 22} textAnchor="middle">{dayLabel(day.dia)}</text>)}
      </svg>
    </section>
  );
}

function DashboardView({ summary }: Readonly<{ summary: DashboardSummary }>) {
  const connections = summary.conexiones;
  const data = summary.datosProcesados;
  const lastJoin = relativeTime(asText(summary.crossJoins.ultimaEjecucion));
  const attention = connections?.requierenAtencion ?? [];
  const degraded = summary.entorno.servicios.filter((service) => service.estado === 'DEGRADADO' || service.estado === 'CAIDO');

  return (
    <>
      <section className="kpi-grid" aria-label="Indicadores principales">
        {connections && (
          <Kpi
            title="Conexiones activas"
            icon="database"
            value={fmt(connections.activas)}
            unit={`/ ${fmt(connections.total)}`}
            trend={<span className="kpi-trend" data-tone="up">{connections.motoresConectados.length} {connections.motoresConectados.length === 1 ? 'motor conectado' : 'motores conectados'}</span>}
            footer={attention.length > 0
              ? <span data-tone="warning"><Icon name="alert" size={13} />{attention.length} {attention.length === 1 ? 'conexión requiere' : 'conexiones requieren'} atención</span>
              : <span>{connections.sinComprobar > 0 ? `${connections.sinComprobar} sin comprobar` : 'Todas responden'}</span>}
          />
        )}
        <Kpi
          title="Cross-Joins este mes"
          icon="join"
          value={fmt(summary.crossJoins.mesActual)}
          trend={<Variation value={summary.crossJoins.variacionPct} label="vs. mes anterior" />}
          footer={<span><Icon name="clock" size={13} />{lastJoin ? `Última ejecución ${lastJoin}` : 'Sin ejecuciones aún'}</span>}
        />
        <Kpi
          title="Datos procesados"
          icon="layers"
          value={formatBytes(data.bytesMesActual).split(' ')[0]}
          unit={formatBytes(data.bytesMesActual).split(' ')[1]}
          trend={<Variation value={data.variacionPct} label="vs. mes anterior" />}
          footer={<span><Icon name="activity" size={13} />{data.usoPlanPct.toLocaleString('es', { maximumFractionDigits: 1 })}% de {formatBytes(data.limitePlanBytes)} incluido en tu plan</span>}
        />
        <Kpi
          title="Exportaciones este mes"
          icon="arrow-up-right"
          value={fmt(summary.exportaciones.mesActual)}
          trend={<Variation value={summary.exportaciones.variacionPct} label="vs. mes anterior" />}
          footer={<span>{summary.reportesProximos?.length ? `${summary.reportesProximos.length} reportes programados próximos` : 'Excel, PDF, Word y JSON'}</span>}
        />
      </section>

      <div className="panel-grid">
        <ApiUsageChart usage={summary.consumoApi} />

        {connections && (
          <section className="surface-card panel-card" aria-labelledby="latency-title">
            <header className="panel-header"><div><h2 id="latency-title">Latencia de conexiones</h2><p>Tiempo de respuesta · última comprobación</p></div></header>
            {connections.latencias.length === 0 ? (
              <p className="panel-empty">Aún no hay comprobaciones de salud. <Link href="/connections">Ver conexiones</Link></p>
            ) : (
              <ul className="latency-list">
                {connections.latencias.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <div><span>{item.nombre}</span><strong data-tone={item.superaUmbral ? 'warning' : 'ok'}>{item.latenciaMs} ms</strong></div>
                    <meter min={0} max={Math.max(connections.umbralLatenciaMs * 1.5, item.latenciaMs)} high={connections.umbralLatenciaMs} value={item.latenciaMs} aria-label={`${item.nombre}: ${item.latenciaMs} ms`} />
                  </li>
                ))}
              </ul>
            )}
            <p className="panel-note">Umbral: {connections.umbralLatenciaMs} ms{asText(connections.ultimaComprobacion) ? ` · actualizado ${relativeTime(asText(connections.ultimaComprobacion))}` : ''}</p>
          </section>
        )}

        {summary.consultasRecientes && (
          <section className="surface-card panel-card panel-card--wide" aria-labelledby="recent-queries-title">
            <header className="panel-header">
              <div><h2 id="recent-queries-title">Continúa donde lo dejaste</h2><p>Accesos rápidos a tus consultas guardadas</p></div>
              <Link className="panel-link" href="/queries">Abrir editor <Icon name="arrow-right" size={13} /></Link>
            </header>
            {summary.consultasRecientes.length === 0 ? (
              <p className="panel-empty">Todavía no hay consultas guardadas. Crea un cruce en el editor de consultas.</p>
            ) : (
              <ul className="recent-list">
                {summary.consultasRecientes.map((query) => (
                  <li key={query.id}>
                    <span className="recent-icon"><Icon name="join" size={15} /></span>
                    <div><strong>{query.nombre}</strong><small>{query.fuentes.join(' + ')}</small></div>
                    <span className="recent-meta">{[asText(query.autor), relativeTime(query.actualizadaEn)].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="surface-card panel-card" aria-labelledby="environment-title">
          <header className="panel-header"><div><h2 id="environment-title">Estado del entorno</h2><p>Todo lo importante, sin ruido.</p></div></header>
          {attention.slice(0, 2).map((item) => (
            <div className="env-alert" key={item.id}>
              <Icon name="alert" size={15} />
              <div><strong>{item.nombre} necesita atención</strong><span>El último health check de {ENGINES[item.tipoMotor as Engine]?.label ?? item.tipoMotor} falló.</span><Link href="/connections">Revisar conexión <Icon name="arrow-right" size={12} /></Link></div>
            </div>
          ))}
          {degraded.map((service) => (
            <div className="env-alert" key={service.servicio}><Icon name="alert" size={15} /><div><strong>{service.servicio}</strong><span>{service.detalle}</span></div></div>
          ))}
          <ul className="service-list">
            {summary.entorno.servicios.map((service) => (
              <li key={service.servicio}><span>{service.servicio}</span><span className="status-pill" data-tone={service.estado === 'OPERATIVO' ? 'ok' : service.estado === 'NO_CONFIGURADO' ? 'muted' : 'error'}><i />{service.estado === 'NO_CONFIGURADO' ? 'No configurado' : service.estado.charAt(0) + service.estado.slice(1).toLowerCase()}</span></li>
            ))}
          </ul>
        </section>

        <section className="surface-card panel-card panel-card--full" aria-labelledby="activity-title">
          <header className="panel-header"><div><h2 id="activity-title">Actividad reciente</h2><p>Últimos eventos de la bitácora</p></div></header>
          {summary.actividadReciente.length === 0 ? (
            <p className="panel-empty">Sin actividad registrada todavía.</p>
          ) : (
            <ul className="activity-feed">
              {summary.actividadReciente.slice(0, 6).map((event) => (
                <li key={event.id}>
                  <span className="status-pill" data-tone={event.resultado === 'SUCCESS' ? 'ok' : 'error'}><i /></span>
                  <div><strong>{event.descripcion}</strong><small>{[asText(event.actor), asText(event.objetivo)].filter(Boolean).join(' · ')}</small></div>
                  <time dateTime={event.fecha}>{relativeTime(event.fecha)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

export default function DashboardPage() {
  const { session } = useAuth();
  const { summary } = useWorkspace();
  const firstName = session?.user.name.split(' ')[0] ?? '';
  const month = summary.data
    ? new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric', timeZone: summary.data.zonaHoraria }).format(new Date(summary.data.generadoEn))
    : null;

  return (
    <>
      <PageHeader
        trail={['Workspace', 'Operaciones']}
        title="Cada conexión, bajo control."
        subtitle={`Hola, ${firstName}. El pulso de tus datos y la actividad de tu equipo, en un solo lugar.`}
        actions={month && <span className="date-button"><Icon name="calendar" size={15} />{month.charAt(0).toUpperCase() + month.slice(1)}</span>}
      />
      {summary.data ? (
        <DashboardView summary={summary.data} />
      ) : summary.error ? (
        <StatusView tone="error" icon="alert" title="No se pudo cargar el resumen" description={summary.error} action={{ label: 'Reintentar', onClick: () => void summary.reload() }} />
      ) : (
        <p className="page-message">Cargando el resumen del workspace…</p>
      )}
      {summary.data && (
        <footer className="dashboard-footer">
          <span>Datos actualizados {relativeTime(summary.data.generadoEn)}</span>
          <span>Zona horaria: {summary.data.zonaHoraria}</span>
        </footer>
      )}
    </>
  );
}
