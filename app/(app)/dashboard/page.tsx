'use client';

import { ConnectionStatus } from '@/components/connection-status';
import { PageHeader } from '@/components/app-shell/page-header';
import { Icon } from '@/components/icons';
import { MetricCard } from '@/components/metric-card';
import { useAuth } from '@/lib/auth-context';
import { useConnectionHealth } from '@/lib/use-connection-health';
import { dashboardMetrics, queryTrend } from '@/lib/mock-data';

const chartY = (value: number) => 142 - (value / 80) * 119;
const chartPoints = queryTrend.map((point, index) => ({
  x: 43 + index * 84,
  y: chartY(point.value),
  day: point.day,
}));
const linePath = chartPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
const areaPath = `M ${chartPoints[0].x} 142 ${chartPoints.map((point) => `L ${point.x} ${point.y}`).join(' ')} L ${chartPoints.at(-1)?.x} 142 Z`;

function DashboardView() {
  const { session } = useAuth();
  const health = useConnectionHealth();
  if (!session) return null;
  const canMonitorConnections = session.user.role === 'ADMIN' || session.user.role === 'OPERADOR';
  const firstName = session.user.name.split(' ')[0] ?? session.user.name;
  const checkedAt = health.report
    ? new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(health.report.checkedAt))
    : null;
  const availableConnections = health.report?.connections.filter((connection) => connection.status === 'HEALTHY').length;
  const connectionMetric = {
    ...dashboardMetrics[0],
    label: 'Conexiones disponibles',
    value: availableConnections === undefined ? '—' : String(availableConnections),
    detail: health.report ? `de ${health.report.connections.length} fuentes` : 'esperando comprobación',
    change: checkedAt ? `Actualizado ${checkedAt}` : health.errorMessage ? 'Sin conexión a API' : 'Verificando',
    changeIcon: 'activity' as const,
  };
  const visibleMetrics = canMonitorConnections
    ? [connectionMetric, ...dashboardMetrics.slice(1)]
    : dashboardMetrics.slice(1, 3);

  return (
    <>
      <PageHeader
        trail={['Workspace', 'Operaciones']}
        title="Vista general"
        subtitle={`Hola, ${firstName}. Aquí tienes lo que pasa con tus datos.`}
        actions={<button className="date-button" type="button"><Icon name="calendar" size={15} />Últimos 30 días<Icon name="chevron-down" size={13} /></button>}
      />

      <section className="summary-grid" aria-label="Indicadores principales">
        {visibleMetrics.map((metric) => <MetricCard key={metric.label} metric={metric} />)}
      </section>

      <div className="dashboard-grid">
        <section className="surface-card trend-card" id="query-trend" aria-labelledby="trend-title">
          <header className="surface-header">
            <div><h2 id="trend-title">Actividad de consultas</h2><p>Ejecuciones en el último mes</p></div>
            <div className="chart-range" aria-label="Rango de tiempo"><span>7 días</span><span className="active">30 días</span><span>90 días</span></div>
          </header>
          <div className="chart-summary"><strong>8,492</strong><span><Icon name="trend-up" size={13} />12.3%</span></div>
          <svg className="trend-chart" viewBox="0 0 620 174" role="img" aria-label="Tendencia semanal de consultas, con crecimiento sostenido">
            <defs>
              <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#65c9aa" stopOpacity=".22" /><stop offset="100%" stopColor="#65c9aa" stopOpacity="0" /></linearGradient>
            </defs>
            {[80, 60, 40, 20].map((value) => {
              const y = chartY(value);
              return <g key={value}><line className="grid-line" x1="36" x2="604" y1={y} y2={y} /><text x="8" y={y + 3}>{value}</text></g>;
            })}
            <path className="chart-area" d={areaPath} />
            <path className="chart-line" d={linePath} />
            {chartPoints.map((point) => <circle className="chart-point" key={point.day} cx={point.x} cy={point.y} r="3.4" />)}
            {chartPoints.map((point) => <text key={`${point.day}-label`} x={point.x} y="163" textAnchor="middle">{point.day}</text>)}
          </svg>
          <div className="chart-legend"><i /> Consultas procesadas</div>
        </section>

        {canMonitorConnections && <ConnectionStatus
          report={health.report}
          isLoading={health.isLoading}
          isRefreshing={health.isRefreshing}
          errorMessage={health.errorMessage}
          onRefresh={health.refresh}
        />}
      </div>

      <footer className="dashboard-footer"><span>{canMonitorConnections ? 'Métricas y actividad de muestra · conexiones verificadas en vivo' : 'Métricas de muestra'}</span><span>Workspace {session.user.workspaceId.slice(0, 8)}</span></footer>
    </>
  );
}

export default function DashboardPage() {
  return <DashboardView />;
}
