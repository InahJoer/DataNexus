'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BrandMark } from '@/components/brand-mark';
import { Icon, type IconName } from '@/components/icons';
import { roleLabels, useAuth, type UserRole } from '@/lib/auth-context';

const navigation: { label: string; icon: IconName; href: string; active?: boolean; roles?: readonly UserRole[] }[] = [
  { label: 'Resumen', icon: 'grid', href: '/dashboard', active: true },
  { label: 'Conexiones', icon: 'plug', href: '#connections' },
  { label: 'Explorador de datos', icon: 'database', href: '#query-trend' },
  { label: 'Cruces de datos', icon: 'join', href: '#joins' },
  { label: 'Reportes', icon: 'layers', href: '#reports' },
  { label: 'Auditoría', icon: 'shield', href: '#activity', roles: ['ADMIN'] },
];

export function DashboardSidebar() {
  const { session, logout } = useAuth();
  const router = useRouter();
  if (!session) return null;

  const { user } = session;
  const initials = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const visibleNavigation = navigation.filter((item) => !item.roles || item.roles.includes(user.role));

  function handleLogout() {
    logout();
    router.replace('/login');
  }

  return (
    <aside className="dashboard-sidebar" aria-label="Navegación del workspace">
      <div className="sidebar-brand"><BrandMark tone="light" /></div>
      <Link className="sidebar-workspace" href="/workspaces" aria-label="Ver workspace asociado">
        <span className="sidebar-workspace-avatar">{initials}</span>
        <span className="sidebar-workspace-copy"><strong>Workspace actual</strong><span>{user.workspaceId.slice(0, 8)}</span></span>
        <Icon name="chevron-down" size={15} />
      </Link>

      <p className="sidebar-section-label">Workspace</p>
      <nav className="sidebar-nav">
        {visibleNavigation.map((item) => (
          <Link key={item.label} href={item.href} aria-current={item.active ? 'page' : undefined}>
            <Icon name={item.icon} size={16} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <div className="sidebar-plan">
          <div className="sidebar-plan-top"><span>Datos de muestra</span><span>DEMO</span></div>
          <p>Las métricas aún no vienen de la API</p>
          <div className="usage-track" aria-label="Las métricas mostradas son de muestra"><span /></div>
          <small>Esta vista usa valores ilustrativos</small>
        </div>
        <div className="sidebar-profile">
          <span className="profile-avatar">{initials}</span>
          <span className="profile-copy"><strong>{user.name}</strong><span>{roleLabels[user.role]}</span></span>
          <button className="sidebar-logout" type="button" onClick={handleLogout}>Salir</button>
        </div>
      </div>
    </aside>
  );
}
