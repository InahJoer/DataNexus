'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export function RequireAuth({ children }: Readonly<{ children: ReactNode }>) {
  const { session } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!session) router.replace('/login');
  }, [session, router]);

  if (!session) {
    return <main className="auth-route-loading" aria-live="polite">Verificando acceso…</main>;
  }

  return children;
}
