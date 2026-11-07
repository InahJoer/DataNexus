'use client';

import { useEffect, useState } from 'react';
import { apiBaseUrl } from '@/lib/api/client';

type Status = 'checking' | 'online' | 'offline';

const CHECK_INTERVAL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;
const LABELS: Record<Status, string> = { checking: 'Comprobando API', online: 'API Online', offline: 'API sin conexión' };

/** Indicador "API Online" de la barra superior: consulta la raíz pública de la API cada 30 s. */
export function ApiStatus() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/`, { cache: 'no-store', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        if (active) setStatus(response.ok ? 'online' : 'offline');
      } catch {
        if (active) setStatus('offline');
      }
    };
    void check();
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <span className="shell-api-status" data-status={status} role="status">
      <i aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}
