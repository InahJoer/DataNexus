import { Icon } from '@/components/icons';
import { dataConnections } from '@/lib/mock-data';

export function ConnectionStatus() {
  return (
    <section className="surface-card connections-card" id="connections" aria-labelledby="connections-title">
      <header className="surface-header">
        <div><h2 id="connections-title">Estado de conexiones</h2><p>Fuentes de datos recientes</p></div>
        <a className="surface-link" href="#connections">Ver todas <Icon name="arrow-up-right" size={13} /></a>
      </header>
      <div className="connection-list">
        {dataConnections.map((connection) => {
          const needsAttention = connection.status !== 'Sincronizado';
          return (
            <div className="connection-row" key={connection.name}>
              <span className={`connection-avatar ${connection.color}`}>{connection.initials}</span>
              <span className="connection-copy"><strong>{connection.name}</strong><span>{connection.kind} · {connection.rows}</span></span>
              <span className={`connection-state${needsAttention ? ' connection-state--warning' : ''}`}>
                <span><i className="status-dot" />{connection.status}</span>
                <small>{connection.lastSync}</small>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
