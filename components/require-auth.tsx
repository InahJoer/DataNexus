'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export function RequireAuth({ children }: Readonly<{ children: ReactNode }>) {
  const { session, status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (!session) {
    return (
      <main className="auth-route-loading" aria-live="polite">
        {status === 'restoring' ? 'Recuperando tu sesión…' : 'Verificando acceso…'}
      </main>
    );
  }

  return children;
}
