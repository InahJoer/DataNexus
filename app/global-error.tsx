'use client';

import '@/styles/base.css';
import '@/styles/login.css';
import '@/styles/app-shell.css';
import { StatusView } from '@/components/app-shell/status-view';

/** Último recurso si falla el layout raíz: reemplaza toda la página, por eso define su propio <html>. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="es">
      <body className="global-error">
        <StatusView
          tone="error"
          icon="alert"
          title="DataNexus no se pudo cargar"
          description="Ocurrió un error inesperado al abrir la aplicación. Inténtalo de nuevo en unos segundos."
          action={{ label: 'Reintentar', onClick: retry }}
        />
      </body>
    </html>
  );
}
