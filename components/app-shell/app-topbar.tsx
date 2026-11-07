'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/icons';
import { ApiStatus } from '@/components/app-shell/api-status';
import { NotificationsMenu } from '@/components/app-shell/notifications-menu';
import { findSection } from '@/lib/navigation';

/** Región del despliegue de la API (por ejemplo, us-east-1). Si no se configura, no se muestra. */
const API_REGION = process.env.NEXT_PUBLIC_API_REGION;

type AppTopbarProps = Readonly<{ sidebarId: string; isMenuOpen: boolean; onToggleMenu: () => void }>;

export function AppTopbar({ sidebarId, isMenuOpen, onToggleMenu }: AppTopbarProps) {
  const section = findSection(usePathname());

  return (
    <header className="shell-topbar">
      <button
        className="shell-icon-button shell-menu-button"
        type="button"
        aria-label={isMenuOpen ? 'Cerrar menú' : 'Abrir menú'}
        aria-expanded={isMenuOpen}
        aria-controls={sidebarId}
        onClick={onToggleMenu}
      >
        <Icon name={isMenuOpen ? 'close' : 'menu'} size={17} />
      </button>

      <nav className="shell-breadcrumb" aria-label="Ruta de navegación">
        <ol>
          <li>{section?.group.label ?? 'DataNexus'}</li>
          {section && (
            <li>
              <Icon name="chevron-right" size={13} />
              <span aria-current="page">{section.item.label}</span>
            </li>
          )}
        </ol>
      </nav>

      <div className="shell-topbar-actions">
        <ApiStatus />
        {API_REGION && <span className="shell-region" title="Región de la API">{API_REGION}</span>}
        <NotificationsMenu />
        <Link className="shell-icon-button" href="/profile" aria-label="Ajustes de mi perfil">
          <Icon name="settings" size={16} />
        </Link>
      </div>
    </header>
  );
}
