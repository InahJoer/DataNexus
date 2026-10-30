import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';
import { Icon, type IconName } from '@/components/icons';
import { sampleWorkspace } from '@/lib/mock-data';

const navigation: { label: string; icon: IconName; href: string; active?: boolean }[] = [
  { label: 'Resumen', icon: 'grid', href: '/dashboard', active: true },
  { label: 'Conexiones', icon: 'plug', href: '#connections' },
  { label: 'Explorador de datos', icon: 'database', href: '#query-trend' },
  { label: 'Cruces de datos', icon: 'join', href: '#joins' },
  { label: 'Reportes', icon: 'layers', href: '#reports' },
  { label: 'Auditoría', icon: 'shield', href: '#activity' },
];

export function DashboardSidebar() {
  return (
    <aside className="dashboard-sidebar" aria-label="Navegación del workspace">
      <div className="sidebar-brand"><BrandMark tone="light" /></div>
      <Link className="sidebar-workspace" href="/workspaces" aria-label={`Workspace actual: ${sampleWorkspace.name}. Cambiar workspace`}>
        <span className="sidebar-workspace-avatar">{sampleWorkspace.initials}</span>
        <span className="sidebar-workspace-copy"><strong>{sampleWorkspace.name}</strong><span>Plan {sampleWorkspace.plan}</span></span>
        <Icon name="chevron-down" size={15} />
      </Link>

      <p className="sidebar-section-label">Workspace</p>
      <nav className="sidebar-nav">
        {navigation.map((item) => (
          <Link key={item.label} href={item.href} aria-current={item.active ? 'page' : undefined}>
            <Icon name={item.icon} size={16} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <div className="sidebar-plan">
          <div className="sidebar-plan-top"><span>Plan {sampleWorkspace.plan}</span><span>ACTIVO</span></div>
          <p>Uso de consultas este mes</p>
          <div className="usage-track" aria-label="72% de uso"><span /></div>
          <small>72% de 12,000 consultas</small>
        </div>
        <div className="sidebar-profile">
          <span className="profile-avatar">AL</span>
          <span className="profile-copy"><strong>Alex Lee</strong><span>Administrador</span></span>
          <Icon name="more" size={17} />
        </div>
      </div>
    </aside>
  );
}
