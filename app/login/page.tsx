import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';
import { Icon } from '@/components/icons';
import { LoginForm } from './login-form';

export default function LoginPage() {
  return (
    <main className="onboarding-shell">
      <aside className="onboarding-aside">
        <div className="onboarding-pattern" aria-hidden="true" />
        <div className="onboarding-aside-inner">
          <BrandMark tone="light" />
          <div className="onboarding-copy">
            <p className="eyebrow eyebrow--light">DATOS CONECTADOS. DECISIONES CLARAS.</p>
            <h1>Todo tu ecosistema de datos, en un solo lugar.</h1>
            <p className="onboarding-lede">
              Reúne tus fuentes, encuentra relaciones y convierte la complejidad en una vista compartida.
            </p>
          </div>
          <div className="onboarding-preview" aria-label="Vista previa de conexiones">
            <div className="preview-heading">
              <span className="preview-orb"><Icon name="activity" size={16} /></span>
              <div>
                <strong>Panorama de datos</strong>
                <span>Actualizado hace 2 min</span>
              </div>
              <span className="preview-live"><i /> En vivo</span>
            </div>
            <div className="preview-graph" aria-hidden="true">
              <div className="preview-node preview-node--one"><Icon name="database" size={16} /><span>CRM</span></div>
              <div className="preview-node preview-node--two"><Icon name="database" size={16} /><span>Warehouse</span></div>
              <div className="preview-node preview-node--three"><Icon name="database" size={16} /><span>Billing</span></div>
              <svg viewBox="0 0 390 86" preserveAspectRatio="none">
                <path d="M63 42 C105 42 107 20 150 20" />
                <path d="M63 44 C112 44 109 66 150 66" />
                <path d="M237 20 C281 20 284 42 327 42" />
                <path d="M237 66 C282 66 283 44 327 44" />
              </svg>
              <span className="preview-center"><Icon name="join" size={15} /></span>
            </div>
            <div className="preview-footer"><span>3 fuentes conectadas</span><span>Sincronización segura <Icon name="arrow-up-right" size={13} /></span></div>
          </div>
          <p className="aside-footnote"><Icon name="lock" size={13} /> Tus credenciales permanecen cifradas y bajo tu control.</p>
        </div>
      </aside>

      <section className="onboarding-main">
        <div className="onboarding-mobile-brand"><BrandMark /></div>
        <div className="auth-card">
          <div className="auth-heading">
            <p className="eyebrow">ACCESO A DATANEXUS</p>
            <h2>Qué bueno verte de nuevo</h2>
            <p>Ingresa tus credenciales para continuar a tu espacio de trabajo.</p>
          </div>
          <LoginForm />
          <div className="auth-divider"><span>ACCESO SEGURO</span></div>
          <div className="security-note"><span className="security-icon"><Icon name="shield" size={17} /></span><span>Protegemos cada conexión con cifrado de nivel empresarial.</span></div>
          <p className="auth-support">¿Necesitas ayuda? <Link href="mailto:soporte@datanexus.app">Contacta a soporte</Link></p>
        </div>
        <footer className="page-footnote"><span>© 2026 DataNexus</span><span>Privacidad <i /> Seguridad <i /> Estado del sistema</span></footer>
      </section>
    </main>
  );
}
