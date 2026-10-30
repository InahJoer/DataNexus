import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';
import { Icon } from '@/components/icons';
import { sampleWorkspace } from '@/lib/mock-data';

export default function WorkspacesPage() {
  return (
    <main className="onboarding-shell">
      <aside className="onboarding-aside onboarding-aside--workspace">
        <div className="onboarding-pattern" aria-hidden="true" />
        <div className="onboarding-aside-inner">
          <BrandMark tone="light" />
          <div className="onboarding-copy">
            <p className="eyebrow eyebrow--light">UN ESPACIO PARA CADA EQUIPO</p>
            <h1>Empieza donde tus datos se encuentran.</h1>
            <p className="onboarding-lede">Tus fuentes, equipos y análisis conviven en un entorno seguro y organizado.</p>
          </div>
          <div className="workspace-side-note">
            <span className="workspace-note-icon"><Icon name="layers" size={17} /></span>
            <div><strong>Un contexto compartido</strong><span>Tu equipo trabaja sobre una sola fuente de verdad.</span></div>
          </div>
          <p className="aside-footnote"><Icon name="lock" size={13} /> Acceso protegido por roles y auditoría.</p>
        </div>
      </aside>

      <section className="onboarding-main">
        <div className="onboarding-mobile-brand"><BrandMark /></div>
        <div className="workspace-card-wrap">
          <div className="workspace-topline">
            <span className="step-indicator"><span>1</span><i /><span className="step-current">2</span></span>
            <span className="step-copy">PASO 2 DE 2</span>
          </div>
          <div className="auth-heading workspace-heading">
            <p className="eyebrow">BIENVENIDO, ALEX</p>
            <h2>Elige tu workspace</h2>
            <p>Selecciona el espacio de trabajo al que quieres entrar.</p>
          </div>

          <Link className="workspace-choice" href="/dashboard">
            <div className="workspace-choice-head">
              <div className="workspace-avatar">{sampleWorkspace.initials}</div>
              <div className="workspace-choice-title"><strong>{sampleWorkspace.name}</strong><span>{sampleWorkspace.domain}</span></div>
              <span className="workspace-check"><Icon name="check" size={16} /></span>
            </div>
            <div className="workspace-choice-meta">
              <span className="plan-pill"><i /> {sampleWorkspace.plan}</span>
              <span><Icon name="users" size={15} /> {sampleWorkspace.members} miembros</span>
              <span><Icon name="clock" size={15} /> Último acceso hoy</span>
            </div>
            <div className="workspace-choice-footer"><span>Conexiones y análisis de tu organización</span><span className="workspace-open">Abrir workspace <Icon name="arrow-right" size={16} /></span></div>
          </Link>

          <div className="workspace-hint"><span className="hint-icon"><Icon name="help" size={16} /></span><p>¿No ves tu espacio? Pídele a un administrador que te invite con tu correo corporativo.</p></div>
          <Link className="back-to-login" href="/login"><Icon name="arrow-left" size={15} /> Volver al acceso</Link>
        </div>
        <footer className="page-footnote"><span>© 2026 DataNexus</span><span>Privacidad <i /> Seguridad <i /> Estado del sistema</span></footer>
      </section>
    </main>
  );
}
