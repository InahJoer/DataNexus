import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DataNexus — Operaciones de datos',
  description: 'Conecta, explora y entiende los datos de tu organización.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
