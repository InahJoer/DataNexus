import type { ReactNode } from 'react';

type PageHeaderProps = Readonly<{
  /** Ruta pequeña sobre el título, por ejemplo ['Workspace', 'Operaciones'] → WORKSPACE / OPERACIONES. */
  trail?: readonly string[];
  title: string;
  subtitle?: string;
  /** Acción principal de la pantalla (botón o enlace). */
  actions?: ReactNode;
}>;

/** Encabezado reutilizable de las pantallas del layout (Figma · Vista general). */
export function PageHeader({ trail, title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        {trail && trail.length > 0 && <p className="eyebrow page-header-trail">{trail.join(' / ').toUpperCase()}</p>}
        <h1>{title}</h1>
        {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
