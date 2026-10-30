import { Icon, type IconName } from '@/components/icons';

type Metric = Readonly<{
  label: string;
  value: string;
  detail: string;
  change: string;
  icon: IconName;
  changeIcon?: IconName;
  tone: 'mint' | 'blue' | 'violet' | 'amber';
}>;

export function MetricCard({ metric }: { metric: Metric }) {
  return (
    <article className="metric-card">
      <div className="metric-top">
        <span className={`metric-icon metric-icon--${metric.tone}`}><Icon name={metric.icon} size={16} /></span>
        <span className="metric-trend"><Icon name={metric.changeIcon ?? 'trend-up'} size={13} />{metric.change}</span>
      </div>
      <p>{metric.label}</p>
      <div className="metric-value-row"><strong className="metric-value">{metric.value}</strong><span className="metric-detail">{metric.detail}</span></div>
    </article>
  );
}
