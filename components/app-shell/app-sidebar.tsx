'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BrandMark } from '@/components/brand-mark';
import { Icon } from '@/components/icons';
import { formatBytes, initialsOf } from '@/components/app-shell/format';
import { useWorkspace } from '@/components/app-shell/workspace-context';
import { roleLabels, useAuth } from '@/lib/auth-context';
import { findSection, navigationFor, type NavItem } from '@/lib/navigation';

const SUPPORT_URL = 'mailto:soporte@datanexus.app';

type AppSidebarProps = Readonly<{ id: string; isOpen: boolean; onNavigate: () => void }>;

export function AppSidebar({ id, isOpen, onNavigate }: AppSidebarProps) {
  const { session, logout } = useAuth();
  const { workspace, summary } = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  if (!session) return null;

  const { user } = session;
  const groups = navigationFor(user.role, workspace.data?.tipoCuenta);
  const activeHref = findSection(pathname)?.item.href;
  const workspaceName = workspace.data?.nombreEmpresa ?? (workspace.isLoading ? 'Cargando…' : 'Workspace');
  const usage = summary.data?.datosProcesados;
  const usagePct = usage ? Math.min(Math.round(usage.usoPlanPct), 100) : null;

  function counterFor(item: NavItem) {
    if (item.counter === 'connections') return summary.data?.conexiones?.total;
    return undefined;
  }

  function handleLogout() {
    logout('manual');
    router.replace('/login');
  }

  return (
    <aside id={id} className="shell-sidebar" data-open={isOpen} aria-label="Menú principal">
      <div className="shell-brand"><BrandMark tone="light" /></div>

      <Link className="shell-workspace" href="/workspaces" onClick={onNavigate}>
        <span className="shell-workspace-label">Workspace activo</span>
        <span className="shell-workspace-name">
          <strong>{workspaceName}</strong>
          <Icon name="chevron-down" size={14} />
        </span>
        <span className="shell-workspace-plan">
          {usage ? `Plan de ${formatBytes(usage.limitePlanBytes)} al mes` : workspace.data?.zonaHoraria ?? ' '}
        </span>
      </Link>

      <nav className="shell-nav" aria-label="Secciones">
        {groups.map((group) => (
          <div className="shell-nav-group" key={group.label}>
            <p className="shell-nav-label">{group.label}</p>
            <ul>
              {group.items.map((item) => {
                const counter = counterFor(item);
                return (
                  <li key={item.href}>
                    <Link href={item.href} aria-current={item.href === activeHref ? 'page' : undefined} onClick={onNavigate}>
                      <Icon name={item.icon} size={16} />
                      <span>{item.label}</span>
                      {counter !== undefined && <span className="shell-nav-counter" aria-label={`${counter} conexiones`}>{counter}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shell-sidebar-bottom">
        {usage && usagePct !== null && (
          <div className="shell-usage">
            <div className="shell-usage-top"><span>Datos procesados</span><strong>{usagePct}%</strong></div>
            <progress className="shell-usage-track" aria-label="Uso del plan este mes" value={usagePct} max={100} />
            <small>{formatBytes(usage.bytesMesActual)} de {formatBytes(usage.limitePlanBytes)} este mes</small>
          </div>
        )}
        <a className="shell-help" href={SUPPORT_URL}><Icon name="help" size={16} />Centro de ayuda</a>
        <div className="shell-user">
          <span className="shell-avatar" aria-hidden="true">{initialsOf(user.name)}</span>
          <span className="shell-user-copy"><strong>{user.name}</strong><span>{roleLabels[user.role]}</span></span>
          <button className="shell-logout" type="button" onClick={handleLogout}>Salir</button>
        </div>
      </div>
    </aside>
  );
}
