import { PageHeader } from '@/components/app-shell/page-header';
import { StatusView } from '@/components/app-shell/status-view';
import type { IconName } from '@/components/icons';

type UpcomingSectionProps = Readonly<{
  trail: readonly string[];
  title: string;
  subtitle: string;
  icon: IconName;
  /** Qué podrá hacer el usuario en esta pantalla cuando esté lista. */
  preview: string;
}>;

/** Sección del menú cuya pantalla aún se está construyendo: ya tiene ruta, encabezado y control de acceso. */
export function UpcomingSection({ trail, title, subtitle, icon, preview }: UpcomingSectionProps) {
  return (
    <>
      <PageHeader trail={trail} title={title} subtitle={subtitle} />
      <StatusView icon={icon} title="Pantalla en preparación" description={preview} />
    </>
  );
}
