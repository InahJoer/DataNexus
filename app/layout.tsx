import type { Metadata } from 'next';
// Estilos por pantalla (carpeta styles/). El ORDEN importa: cada archivo puede sobrescribir
// reglas de los anteriores, igual que en una sola hoja de estilos. Ver styles/README.md.
import '@/styles/base.css';
import '@/styles/onboarding.css';
import '@/styles/login.css';
import '@/styles/workspaces.css';
import '@/styles/dashboard.css';
import '@/styles/responsive.css';
import '@/styles/auth.css';
import '@/styles/cross-join.css';
import '@/styles/audit.css';
import '@/styles/app-shell.css';
import '@/styles/connections.css';
import '@/styles/explorer.css';
import { AuthProvider } from '@/components/auth-provider';
import { IdleWarning } from '@/components/idle-warning';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'DataNexus — Operaciones de datos',
  description: 'Conecta, explora y entiende los datos de tu organización.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Tema claro u oscuro antes de pintar (preferencia guardada en Mi perfil). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <AuthProvider>
          {children}
          <IdleWarning />
        </AuthProvider>
      </body>
    </html>
  );
}
