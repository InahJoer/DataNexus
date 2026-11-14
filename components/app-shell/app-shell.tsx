'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppSidebar } from '@/components/app-shell/app-sidebar';
import { AppTopbar } from '@/components/app-shell/app-topbar';
import { StatusView } from '@/components/app-shell/status-view';
import { WorkspaceProvider } from '@/components/app-shell/workspace-context';
import { useAuth } from '@/lib/auth-context';
import { canSee, findSection } from '@/lib/navigation';

const SIDEBAR_ID = 'app-sidebar';

/**
 * Layout base de las pantallas autenticadas (#42): sidebar con el MainMenu por rol, barra superior y contenido.
 * Si el rol no puede ver la sección de la URL (por ejemplo, un LECTOR que escribe /audit), muestra un aviso en lugar
 * de la pantalla.
 */
export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  const { session } = useAuth();
  const pathname = usePathname();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 901px)');
    const sync = () => setIsDesktop(media.matches);
    sync();
    media.addEventListener('change', sync);
    try { setIsCollapsed(window.localStorage.getItem('datanexus:sidebar:collapsed') === 'true'); } catch {}
    return () => media.removeEventListener('change', sync);
  }, []);

  function toggleMenu() {
    if (!isDesktop) { setIsMenuOpen((open) => !open); return; }
    setIsCollapsed((collapsed) => {
      try { window.localStorage.setItem('datanexus:sidebar:collapsed', String(!collapsed)); } catch {}
      return !collapsed;
    });
  }

  // En móvil el menú es un panel: se cierra al navegar y con Escape.
  useEffect(() => setIsMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!isMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isMenuOpen]);

  const section = findSection(pathname);
  const isAllowed = !section || canSee(section.item, session?.user.role);

  return (
    <WorkspaceProvider>
      <div className="shell" data-collapsed={isCollapsed}>
        <AppSidebar id={SIDEBAR_ID} isOpen={isMenuOpen} onNavigate={() => setIsMenuOpen(false)} />
        {isMenuOpen && <div className="shell-backdrop" aria-hidden="true" onClick={() => setIsMenuOpen(false)} />}
        <div className="shell-main">
          <AppTopbar sidebarId={SIDEBAR_ID} isMenuOpen={isDesktop ? !isCollapsed : isMenuOpen} onToggleMenu={toggleMenu} />
          <main className="shell-content" id="contenido">
            {isAllowed ? (
              children
            ) : (
              <StatusView
                tone="warning"
                icon="lock"
                title="No tienes acceso a esta sección"
                description="Tu rol no incluye permisos para esta pantalla. Si la necesitas, pide acceso a un administrador del workspace."
                action={{ label: 'Ir a la Vista general', href: '/dashboard' }}
              />
            )}
          </main>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
