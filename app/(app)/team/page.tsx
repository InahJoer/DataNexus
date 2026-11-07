import { UpcomingSection } from '@/components/app-shell/upcoming-section';

export default function TeamPage() {
  return (
    <UpcomingSection
      trail={['Workspace', 'Equipo']}
      title="Equipo"
      subtitle="Miembros del workspace, sus roles e invitaciones."
      icon="users"
      preview="Aquí podrás invitar personas, cambiar su rol y revisar sus sesiones activas."
    />
  );
}
