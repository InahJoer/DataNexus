import { Icon } from '@/components/icons';
import { recentActivity } from '@/lib/mock-data';

export function ActivityList() {
  return (
    <section className="surface-card activity-card" id="activity" aria-labelledby="activity-title">
      <header className="surface-header">
        <div><h2 id="activity-title">Actividad reciente</h2><p>Lo que sucede en tu workspace</p></div>
        <a className="surface-link" href="#activity">Ver actividad <Icon name="arrow-up-right" size={13} /></a>
      </header>
      <div className="activity-list">
        {recentActivity.map((activity) => (
          <div className="activity-row" key={`${activity.initials}-${activity.target}`}>
            <span className={`activity-avatar ${activity.tone}`}>{activity.initials}</span>
            <span className="activity-copy"><strong>{activity.name}</strong> {activity.action}<span>{activity.target}</span></span>
            <time className="activity-time">{activity.time}</time>
          </div>
        ))}
      </div>
    </section>
  );
}
