import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell/app-shell';
import { RequireAuth } from '@/components/require-auth';

/** Pantallas autenticadas: todas comparten el sidebar con el MainMenu por rol y la barra superior (#42). */
export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}
