import { PageHeader } from '@/components/app-shell/page-header';
import { QueryBuilder } from '@/components/query-builder/query-builder';

export default function QueriesPage() {
  return (
    <>
      <PageHeader
        trail={['Workspace', 'Consultas']}
        title="Query Builder"
        subtitle="Arrastra tablas, colecciones y subcolecciones de cualquier conexión, únelas en el lienzo y explora el resultado."
      />
      <QueryBuilder />
    </>
  );
}
