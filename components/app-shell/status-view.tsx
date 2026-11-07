import Link from 'next/link';
import { Icon, type IconName } from '@/components/icons';

type StatusViewProps = Readonly<{
  title: string;
  description: string;
  icon?: IconName;
  tone?: 'neutral' | 'warning' | 'error';
  /** Enlace (href) o botón (onClick) de la acción principal. */
  action?: { label: string; href: string } | { label: string; onClick: () => void };
}>;

/** Estado vacío, sin acceso o de error que ocupa el contenido de una pantalla. */
export function StatusView({ title, description, icon = 'help', tone = 'neutral', action }: StatusViewProps) {
  return (
    <section className="status-view" data-tone={tone} aria-labelledby="status-view-title">
      <span className="status-view-icon"><Icon name={icon} size={20} /></span>
      <h2 id="status-view-title">{title}</h2>
      <p>{description}</p>
      {action &&
        ('href' in action ? (
          <Link className="button status-view-action" href={action.href}>{action.label}</Link>
        ) : (
          <button className="button status-view-action" type="button" onClick={action.onClick}>{action.label}</button>
        ))}
    </section>
  );
}
