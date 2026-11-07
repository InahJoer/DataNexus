import { UpcomingSection } from '@/components/app-shell/upcoming-section';

export default function ExecutionsPage() {
  return (
    <UpcomingSection
      trail={['Workspace', 'Ejecuciones']}
      title="Ejecuciones"
      subtitle="Historial de reportes enviados y trabajos en segundo plano."
      icon="activity"
      preview="Aquí verás cada ejecución con su estado, duración, tamaño y el motivo si falló."
    />
  );
}
