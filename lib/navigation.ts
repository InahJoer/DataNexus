import type { IconName } from '@/components/icons';
import type { UserRole } from '@/lib/auth-context';
import { hasPermission, type Permission } from '@/lib/permissions';

export type NavItem = Readonly<{
  label: string;
  href: string;
  icon: IconName;
  /** Permiso necesario para ver la sección; sin permiso, la ve cualquier rol. */
  permission?: Permission;
  /** Muestra junto al enlace el número de conexiones del workspace. */
  counter?: 'connections';
}>;

export type NavGroup = Readonly<{ label: string; items: readonly NavItem[] }>;

/** MainMenu de la aplicación (Figma · Vista general). Una sola fuente para el sidebar, el breadcrumb y el control de acceso. */
export const NAVIGATION: readonly NavGroup[] = [
  {
    label: 'Plataforma',
    items: [
      { label: 'Vista general', href: '/dashboard', icon: 'grid' },
      { label: 'Workspaces', href: '/workspaces', icon: 'layers' },
      { label: 'Conexiones', href: '/connections', icon: 'database', permission: 'VIEW_CONNECTIONS', counter: 'connections' },
      { label: 'Explorador de datos', href: '/explorer', icon: 'table', permission: 'EXPLORE_DATA' },
      { label: 'Editor de consultas', href: '/queries', icon: 'join', permission: 'RUN_JOINS' },
      { label: 'Ejecuciones', href: '/executions', icon: 'activity', permission: 'MANAGE_REPORTS' },
      { label: 'Tareas programadas', href: '/scheduled-tasks', icon: 'clock', permission: 'MANAGE_REPORTS' },
      { label: 'Equipo', href: '/team', icon: 'users', permission: 'MANAGE_MEMBERS' },
    ],
  },
  {
    label: 'Administración',
    items: [
      { label: 'Auditoría', href: '/audit', icon: 'shield', permission: 'READ_AUDIT' },
      { label: 'Mi perfil', href: '/profile', icon: 'user' },
    ],
  },
];

export function canSee(item: NavItem, role: UserRole | undefined): boolean {
  return !item.permission || hasPermission(role, item.permission);
}

/** Menú filtrado por rol: los grupos sin ninguna sección visible desaparecen. */
export function navigationFor(role: UserRole | undefined): NavGroup[] {
  return NAVIGATION.map((group) => ({ ...group, items: group.items.filter((item) => canSee(item, role)) })).filter(
    (group) => group.items.length > 0,
  );
}

/** Sección (y su grupo) a la que pertenece una ruta, incluidas sus subrutas (/connections/123 → Conexiones). */
export function findSection(pathname: string): { group: NavGroup; item: NavItem } | null {
  for (const group of NAVIGATION) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return { group, item };
    }
  }
  return null;
}
