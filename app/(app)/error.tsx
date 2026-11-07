'use client';

import { useEffect } from 'react';
import { StatusView } from '@/components/app-shell/status-view';

/** Error inesperado en una pantalla: se muestra dentro del layout para que el usuario pueda seguir navegando. */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusView
      tone="error"
      icon="alert"
      title="Esta pantalla no se pudo cargar"
      description="Ocurrió un error inesperado. Puedes intentarlo de nuevo o ir a otra sección desde el menú."
      action={{ label: 'Reintentar', onClick: retry }}
    />
  );
}
