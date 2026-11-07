import { StatusView } from '@/components/app-shell/status-view';

export default function NotFound() {
  return (
    <main className="global-error">
      <StatusView
        icon="search"
        title="No encontramos esta página"
        description="La dirección no existe o cambió. Vuelve a la Vista general para seguir trabajando."
        action={{ label: 'Ir a la Vista general', href: '/dashboard' }}
      />
    </main>
  );
}
