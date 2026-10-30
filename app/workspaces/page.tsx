'use client';

import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';
import { Icon } from '@/components/icons';
import { RequireAuth } from '@/components/require-auth';
import { roleLabels, useAuth } from '@/lib/auth-context';

function WorkspaceSelection() {
  const { session, logout } = useAuth();
  if (!session) return null;

  const { user } = session;
  const firstName = user.name.split(' ')[0] ?? user.name;
  const initials = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

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
            <p className="eyebrow">BIENVENIDO, {firstName.toUpperCase()}</p>
            <h2>Tu workspace</h2>
            <p>Este es el espacio asociado a tu cuenta.</p>
          </div>

          <Link className="workspace-choice" href="/dashboard">
            <div className="workspace-choice-head">
              <div className="workspace-avatar">{initials}</div>
              <div className="workspace-choice-title"><strong>Workspace asociado</strong><span>ID {user.workspaceId}</span></div>
              <span className="workspace-check"><Icon name="check" size={16} /></span>
            </div>
            <div className="workspace-choice-meta">
              <span className="plan-pill"><i /> {roleLabels[user.role]}</span>
              <span><Icon name="mail" size={15} /> {user.email}</span>
            </div>
            <div className="workspace-choice-footer"><span>Tu usuario tiene un workspace asociado</span><span className="workspace-open">Abrir workspace <Icon name="arrow-right" size={16} /></span></div>
          </Link>

          <div className="workspace-hint"><span className="hint-icon"><Icon name="help" size={16} /></span><p>La API actual asocia una cuenta a un solo workspace; la gestión de varios espacios aún no está disponible.</p></div>
          <Link className="back-to-login" href="/login" onClick={logout}><Icon name="arrow-left" size={15} /> Cerrar sesión</Link>
        </div>
        <footer className="page-footnote"><span>© 2026 DataNexus</span><span>Privacidad <i /> Seguridad <i /> Estado del sistema</span></footer>
      </section>
    </main>
  );
}

export default function WorkspacesPage() {
  return <RequireAuth><WorkspaceSelection /></RequireAuth>;
}
