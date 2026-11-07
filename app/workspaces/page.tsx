'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { initialsOf } from '@/components/app-shell/format';
import { AuthAlert, AuthHeading, AuthLayout } from '@/components/auth/auth-layout';
import { Icon } from '@/components/icons';
import { RequireAuth } from '@/components/require-auth';
import type { ApiClient } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/use-api-query';
import { roleLabels, useAuth } from '@/lib/auth-context';

function WorkspaceSelection() {
  const { session, logout } = useAuth();
  const router = useRouter();
  const workspace = useApiQuery(useCallback((api: ApiClient) => api.GET('/workspaces/me'), []));
  if (!session) return null;

  const { user } = session;
  const firstName = user.name.split(' ')[0] ?? user.name;
  const workspaceName = workspace.data?.nombreEmpresa ?? (workspace.isLoading ? 'Cargando workspace…' : 'Tu workspace');

  function handleLogout() {
    logout('manual');
    router.replace('/login');
  }

  return (
    <AuthLayout>
      <div className="workspace-topline">
        <span className="step-indicator"><span>1</span><i /><span className="step-current">2</span></span>
        <span className="step-copy">PASO 2 DE 2</span>
      </div>
      <AuthHeading eyebrow={`BIENVENIDO, ${firstName.toUpperCase()}`} title="Elige tu workspace activo." description="Estos son los espacios a los que tienes acceso." />

      {workspace.error && <AuthAlert tone="error" title="No pudimos cargar tu workspace">{workspace.error}</AuthAlert>}

      <p className="field-label" id="workspace-label">Workspace activo</p>
      <Link className="workspace-choice" href="/dashboard" aria-describedby="workspace-label">
        <div className="workspace-choice-head">
          <div className="workspace-avatar">{initialsOf(workspace.data?.nombreEmpresa ?? user.name)}</div>
          <div className="workspace-choice-title">
            <strong>{workspaceName}</strong>
            <span>Tu rol en este espacio: {roleLabels[user.role]}</span>
          </div>
          <span className="workspace-check"><Icon name="check" size={16} /></span>
        </div>
        <div className="workspace-choice-meta">
          <span className="plan-pill"><i /> {roleLabels[user.role]}</span>
          <span><Icon name="mail" size={15} /> {user.email}</span>
          {workspace.data?.zonaHoraria && <span><Icon name="clock" size={15} /> {workspace.data.zonaHoraria}</span>}
        </div>
        <div className="workspace-choice-footer"><span>Entrar con este workspace</span><span className="workspace-open">Abrir workspace <Icon name="arrow-right" size={16} /></span></div>
      </Link>

      <div className="workspace-hint">
        <span className="hint-icon"><Icon name="help" size={16} /></span>
        <p>Por ahora cada cuenta pertenece a un solo workspace. Si necesitas acceso a otro, pide una invitación a su administrador.</p>
      </div>
      <button className="back-to-login" type="button" onClick={handleLogout}><Icon name="arrow-left" size={15} /> Cerrar sesión</button>
    </AuthLayout>
  );
}

export default function WorkspacesPage() {
  return <RequireAuth><WorkspaceSelection /></RequireAuth>;
}
