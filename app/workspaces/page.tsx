'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { initialsOf } from '@/components/app-shell/format';
import { AuthAlert, AuthHeading, AuthLayout } from '@/components/auth/auth-layout';
import { WorkspaceSettingsModal } from '@/components/workspaces/workspace-settings-modal';
import { Icon } from '@/components/icons';
import { RequireAuth } from '@/components/require-auth';
import type { ApiClient } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/use-api-query';
import { roleLabels, useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/permissions';

/** Lee `total` de los bloques de estadísticas (OpenAPI los tipa como objetos sin forma). */
function totalOf(block: unknown): number | null {
  return block && typeof block === 'object' && 'total' in block && typeof block.total === 'number' ? block.total : null;
}

function WorkspaceSelection() {
  const { session, logout } = useAuth();
  const router = useRouter();
  const workspace = useApiQuery(useCallback((api: ApiClient) => api.GET('/workspaces/me'), []));
  const stats = useApiQuery(useCallback((api: ApiClient) => api.GET('/workspaces/me/stats'), []));
  const [isEditing, setIsEditing] = useState(false);
  if (!session) return null;

  const { user } = session;
  const data = workspace.data;
  const isPersonal = data?.tipoCuenta === 'PERSONAL';
  const canManage = hasPermission(user.role, 'MANAGE_WORKSPACE');
  const firstName = user.name.split(' ')[0] ?? user.name;
  const members = totalOf(stats.data?.miembros);
  const connections = totalOf(stats.data?.conexiones);

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

      <p className="field-label" id="workspace-label">Mis workspaces <span className="count-pill">1</span></p>
      <div className="workspace-choice" aria-describedby="workspace-label">
        <div className="workspace-choice-head">
          <div className="workspace-avatar">{initialsOf(data?.nombreEmpresa ?? user.name)}</div>
          <div className="workspace-choice-title">
            <strong>{data?.nombreEmpresa ?? (workspace.isLoading ? 'Cargando workspace…' : 'Tu workspace')}</strong>
            <span>{data?.descripcion ?? `Tu rol en este espacio: ${roleLabels[user.role]}`}</span>
          </div>
          {data && <span className="account-badge" data-type={data.tipoCuenta}><Icon name={isPersonal ? 'user' : 'users'} size={12} />{isPersonal ? 'Personal' : 'Organización'}</span>}
        </div>
        <div className="workspace-choice-meta">
          <span className="plan-pill"><i /> {roleLabels[user.role]}</span>
          {connections !== null && <span><Icon name="database" size={15} /> {connections} {connections === 1 ? 'conexión' : 'conexiones'}</span>}
          {members !== null && !isPersonal && <span><Icon name="users" size={15} /> {members} {members === 1 ? 'miembro' : 'miembros'}</span>}
          {data?.zonaHoraria && <span><Icon name="clock" size={15} /> {data.zonaHoraria}</span>}
        </div>
        <div className="workspace-choice-footer">
          {canManage && data ? (
            <button type="button" className="row-action" onClick={() => setIsEditing(true)}><Icon name="settings" size={13} /> Editar workspace</button>
          ) : <span>Entrar con este workspace</span>}
          <Link className="workspace-open" href="/dashboard">Abrir workspace <Icon name="arrow-right" size={16} /></Link>
        </div>
      </div>

      {isPersonal && canManage && (
        <div className="workspace-hint">
          <span className="hint-icon"><Icon name="users" size={16} /></span>
          <p>¿Vas a trabajar con tu equipo? <button type="button" className="auth-link inline-link" onClick={() => setIsEditing(true)}>Convierte tu espacio en organización</button> para invitar miembros con roles.</p>
        </div>
      )}
      {!isPersonal && (
        <div className="workspace-hint">
          <span className="hint-icon"><Icon name="help" size={16} /></span>
          <p>Cada cuenta pertenece a un workspace. Para trabajar en otra organización, pide una invitación a su administrador o <Link className="auth-link inline-link" href="/signup?tipo=organizacion">crea una nueva organización</Link> con otro correo.</p>
        </div>
      )}
      <button className="back-to-login" type="button" onClick={handleLogout}><Icon name="arrow-left" size={15} /> Cerrar sesión</button>

      {isEditing && data && (
        <WorkspaceSettingsModal workspace={data} onClose={() => setIsEditing(false)} onSaved={() => { setIsEditing(false); void workspace.reload(); }} />
      )}
    </AuthLayout>
  );
}

export default function WorkspacesPage() {
  return <RequireAuth><WorkspaceSelection /></RequireAuth>;
}
