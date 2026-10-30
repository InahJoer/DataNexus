import { Icon } from '@/components/icons';
import type { components } from '@/lib/api/schema';

type ConnectionHealthReport = components['schemas']['ConnectionHealthResponseDto'];
type ConnectionHealthItem = components['schemas']['ConnectionHealthItemDto'];

type Props = Readonly<{
  report: ConnectionHealthReport | null;
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
  onRefresh: () => Promise<void>;
}>;

const healthLabels: Record<ConnectionHealthItem['status'], string> = {
  HEALTHY: 'Disponible',
  UNAVAILABLE: 'Sin respuesta',
  UNSUPPORTED: 'Motor no compatible',
};

function engineInitials(engine: string) {
  return engine.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
}

function engineClass(engine: string) {
  const value = engine.toLowerCase();
  if (value.includes('postgres')) return 'connection-postgres';
  if (value.includes('mysql')) return 'connection-mysql';
  if (value.includes('sqlserver') || value.includes('mssql')) return 'connection-sqlserver';
  if (value.includes('firestore') || value.includes('firebase')) return 'connection-firestore';
  return 'connection-generic';
}

function formatCheckedAt(value: string) {
  return new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function ConnectionStatus({ report, isLoading, isRefreshing, errorMessage, onRefresh }: Props) {
  const checkedAt = report ? formatCheckedAt(report.checkedAt) : null;
  const refreshDisabled = isLoading || isRefreshing;

  return (
    <section className="surface-card connections-card" id="connections" aria-labelledby="connections-title">
      <header className="surface-header">
        <div>
          <h2 id="connections-title">Estado de conexiones</h2>
          <p>{checkedAt ? `Última comprobación ${checkedAt}` : 'Comprobando fuentes del workspace'}</p>
        </div>
        <button
          className="surface-link connection-refresh"
          type="button"
          onClick={() => void onRefresh()}
          disabled={refreshDisabled}
          aria-label="Actualizar estado de conexiones"
        >
          {isRefreshing ? 'Actualizando…' : 'Actualizar'}
        </button>
      </header>

      {errorMessage && report && <p className="connection-inline-error" role="status">{errorMessage} Se muestran los últimos datos recibidos.</p>}

      {isLoading && !report ? (
        <p className="connection-message" role="status">Consultando disponibilidad…</p>
      ) : errorMessage && !report ? (
        <div className="connection-message connection-message--error" role="alert">
          <p>{errorMessage}</p>
          <button type="button" onClick={() => void onRefresh()}>Reintentar</button>
        </div>
      ) : report?.connections.length === 0 ? (
        <p className="connection-message">Todavía no hay conexiones configuradas en este workspace.</p>
      ) : (
        <div className="connection-list">
          {report?.connections.map((connection) => {
            const healthy = connection.status === 'HEALTHY';
            const unsupported = connection.status === 'UNSUPPORTED';
            const tone = healthy ? '' : unsupported ? ' connection-state--unknown' : ' connection-state--error';
            const latency = connection.latencyMs === null ? 'Sin medición' : `${connection.latencyMs} ms`;

            return (
              <div className="connection-row" key={connection.connectionId}>
                <span className={`connection-avatar ${engineClass(connection.tipoMotor)}`}>{engineInitials(connection.tipoMotor)}</span>
                <span className="connection-copy">
                  <strong>{connection.dbName || 'Base de datos'}</strong>
                  <span>{connection.tipoMotor} · {connection.host}</span>
                </span>
                <span className={`connection-state${tone}`}>
                  <span><i className="status-dot" />{healthLabels[connection.status]}</span>
                  <small>{latency} · {checkedAt}</small>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
