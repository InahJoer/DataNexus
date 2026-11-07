import type { ReactNode } from 'react';
import { ApiStatus } from '@/components/app-shell/api-status';
import { BrandMark } from '@/components/brand-mark';
import { Icon, type IconName } from '@/components/icons';

const SOURCES: readonly { name: string; detail: string; icon: IconName; position: string }[] = [
  { name: 'PostgreSQL', detail: 'Almacén analítico', icon: 'database', position: 'top-left' },
  { name: 'Firebase', detail: 'Eventos en vivo', icon: 'spark', position: 'top-right' },
  { name: 'SQL Server', detail: 'ERP · Producción', icon: 'layers', position: 'bottom-left' },
  { name: 'Cross-Join', detail: 'Una sola consulta', icon: 'join', position: 'bottom-right' },
];

/**
 * Layout de dos columnas de las pantallas de acceso (Figma · Acceso): mensaje de marca con el diagrama de fuentes a
 * la izquierda y el formulario a la derecha. Lo comparten login, workspace, recuperación, restablecimiento e
 * invitación.
 */
export function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="onboarding-shell">
      <aside className="onboarding-aside">
        <div className="onboarding-pattern" aria-hidden="true" />
        <div className="onboarding-aside-inner">
          <BrandMark tone="light" />
          <div className="onboarding-copy">
            <p className="auth-badge"><i aria-hidden="true" />INTEGRACIÓN DE DATOS HÍBRIDOS</p>
            <h1>Tus datos, conectados. Tu equipo, en sincronía.</h1>
            <p className="onboarding-lede">
              Une tus bases SQL y NoSQL en un solo espacio. Consulta sin fronteras, con seguridad en cada conexión.
            </p>
          </div>

          <div className="auth-diagram" aria-label="PostgreSQL, Firebase y SQL Server conectados en DataNexus para un Cross-Join">
            <svg className="auth-diagram-lines" viewBox="0 0 400 200" preserveAspectRatio="none" aria-hidden="true">
              <path d="M110 34 H150 V86 H168" />
              <path d="M110 166 H150 V114 H168" />
              <path d="M290 34 H250 V86 H232" />
              <path d="M290 166 H250 V114 H232" />
            </svg>
            {SOURCES.map((source) => (
              <div className={`auth-source auth-source--${source.position}`} key={source.name} aria-hidden="true">
                <strong><Icon name={source.icon} size={14} />{source.name}</strong>
                <span>{source.detail}</span>
              </div>
            ))}
            <span className="auth-diagram-hub" aria-hidden="true"><Icon name="layers" size={20} /><small>DataNexus</small></span>
          </div>

          <div className="auth-trust">
            <Icon name="shield" size={16} />
            <div><strong>La confianza es parte de la arquitectura.</strong><span>Cifrado AES-256 en reposo · Acceso por workspace</span></div>
          </div>
          <p className="aside-footnote">© 2026 DataNexus · Infraestructura que conecta.</p>
        </div>
      </aside>

      <section className="onboarding-main">
        <header className="auth-topline">
          <div className="onboarding-mobile-brand"><BrandMark /></div>
          <span className="auth-console">CONSOLA DE DATOS</span>
          <ApiStatus />
        </header>
        <div className="auth-card">{children}</div>
        <footer className="page-footnote">
          <span>Privacidad <i /> Términos de servicio</span>
          <span>Español (ES)</span>
        </footer>
      </section>
    </main>
  );
}

type AuthHeadingProps = Readonly<{ eyebrow?: string; title: string; description: ReactNode }>;

export function AuthHeading({ eyebrow, title, description }: AuthHeadingProps) {
  return (
    <div className="auth-heading">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

type AuthAlertProps = Readonly<{ tone: 'warning' | 'error' | 'success'; title: string; children?: ReactNode }>;

/** Aviso destacado del formulario: sesión expirada, cuenta bloqueada, enlace inválido o correo enviado. */
export function AuthAlert({ tone, title, children }: AuthAlertProps) {
  return (
    <div className="auth-alert" data-tone={tone} role={tone === 'success' ? 'status' : 'alert'}>
      <Icon name={tone === 'success' ? 'check' : 'alert'} size={16} />
      <div><strong>{title}</strong>{children && <span>{children}</span>}</div>
    </div>
  );
}
