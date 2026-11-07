'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Lee el token de un enlace de correo (?token=…) y lo quita de la barra de direcciones para que no quede en el
 * historial ni se envíe como Referer. Devuelve undefined mientras se lee y null si el enlace no trae token.
 */
export function useLinkToken(): string | null | undefined {
  const searchParams = useSearchParams();
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const value = searchParams.get('token');
    setToken((current) => current ?? value);
    if (value) window.history.replaceState(null, '', window.location.pathname);
  }, [searchParams]);

  return token;
}
