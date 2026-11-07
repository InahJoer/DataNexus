import { CrossJoinBuilder } from '@/components/cross-join-builder';
import { PageHeader } from '@/components/app-shell/page-header';

export default function QueriesPage() {
  return (
    <>
      <PageHeader
        trail={['Workspace', 'Consultas']}
        title="Editor de consultas"
        subtitle="Cruza una tabla SQL con una colección NoSQL y explora el resultado."
      />
      <CrossJoinBuilder />
    </>
  );
}
