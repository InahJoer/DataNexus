import { UpcomingSection } from '@/components/app-shell/upcoming-section';

export default function ScheduledTasksPage() {
  return (
    <UpcomingSection
      trail={['Workspace', 'Automatización']}
      title="Tareas programadas"
      subtitle="Reportes que se generan y envían solos."
      icon="clock"
      preview="Aquí podrás crear, pausar y editar los reportes programados de tu workspace."
    />
  );
}
