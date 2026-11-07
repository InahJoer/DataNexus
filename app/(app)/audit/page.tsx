import { AuditTable } from '@/components/audit-table';
import { PageHeader } from '@/components/app-shell/page-header';

export default function AuditPage() {
  return (
    <>
      <PageHeader
        trail={['Administración', 'Auditoría']}
        title="Bitácora de auditoría"
        subtitle="Registro inmutable de accesos, cambios de configuración y operaciones sobre los datos."
      />
      <AuditTable />
    </>
  );
}
