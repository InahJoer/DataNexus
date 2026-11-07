import { UpcomingSection } from '@/components/app-shell/upcoming-section';

export default function ConnectionsPage() {
  return (
    <UpcomingSection
      trail={['Workspace', 'Conexiones']}
      title="Conexiones"
      subtitle="Bases de datos SQL y NoSQL conectadas a tu workspace."
      icon="database"
      preview="Aquí podrás ver todas tus conexiones, comprobar su estado y crear, editar o eliminar conexiones."
    />
  );
}
