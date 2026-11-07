import { PageHeader } from '@/components/app-shell/page-header';
import { JoinBuilder } from '@/components/joins/join-builder';

export default function QueriesPage() {
  return (
    <>
      <PageHeader
        trail={['Workspace', 'Consultas']}
        title="Editor de consultas"
        subtitle="Combina tablas, colecciones y subcolecciones de cualquier conexión y explora el resultado."
      />
      <JoinBuilder />
    </>
  );
}
