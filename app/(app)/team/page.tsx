'use client';

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { initialsOf } from '@/components/app-shell/format';
import { Modal } from '@/components/app-shell/modal';
import { PageHeader } from '@/components/app-shell/page-header';
import { StatusView } from '@/components/app-shell/status-view';
import { useWorkspace } from '@/components/app-shell/workspace-context';
import { Icon } from '@/components/icons';
import type { ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useApiQuery } from '@/lib/api/use-api-query';
import { roleLabels, type UserRole } from '@/lib/auth-context';
import type { components } from '@/lib/api/schema';

type Member = components['schemas']['MemberResponseDto'];
type Invitation = components['schemas']['InvitationResponseDto'];
type Dialog = { kind: 'invite' } | { kind: 'remove'; member: Member } | { kind: 'revoke-all' } | null;

const ROLES: UserRole[] = ['ADMIN', 'OPERADOR', 'LECTOR', 'AUDITOR'];
const ROLE_INFO: Record<UserRole, { detail: string; can: string[] }> = {
  ADMIN: { detail: 'Control total del workspace.', can: ['Conexiones y miembros', 'Configuración y campos sensibles', 'Todo lo de los demás roles'] },
  OPERADOR: { detail: 'Analista BI del día a día.', can: ['Explorar y editar datos', 'Cruces, exportaciones y reportes', 'Ve los datos sin enmascarar'] },
  LECTOR: { detail: 'Consulta sin editar.', can: ['Vista general y consultas publicadas', 'Datos sensibles enmascarados', 'Sin edición ni exportación'] },
  AUDITOR: { detail: 'Supervisión de TI.', can: ['Bitácora de auditoría completa', 'Sin acceso a datos de negocio', 'Ideal para cumplimiento'] },
};

function lastAccess(value: string | null) {
  if (!value) return 'Nunca';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 2) return 'Ahora';
  if (minutes < 60) return `Hace ${minutes} min`;
  if (minutes < 60 * 24) return `Hace ${Math.round(minutes / 60)} h`;
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

/** Usuarios y permisos (#71): miembros, roles, invitaciones y sesiones. Solo ADMIN. */
export default function TeamPage() {
  const call = useApiCall();
  const { workspace } = useWorkspace();
  const members = useApiQuery(useCallback((api: ApiClient) => api.GET('/users'), []));
  const invitations = useApiQuery(useCallback((api: ApiClient) => api.GET('/users/invitations', { params: { query: { estado: 'PENDIENTE' } } }), []));
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRole | ''>('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [invite, setInvite] = useState({ name: '', email: '', role: 'LECTOR' as UserRole });

  const list = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (members.data ?? []).filter((member) =>
      (!roleFilter || member.role === roleFilter) && (!term || `${member.name} ${member.email}`.toLowerCase().includes(term)),
    );
  }, [members.data, search, roleFilter]);

  if (workspace.data?.tipoCuenta === 'PERSONAL') {
    return (
      <>
        <PageHeader trail={['Workspace', 'Equipo']} title="Equipo" subtitle="Miembros del workspace, sus roles e invitaciones." />
        <StatusView icon="users" title="Tu espacio es personal" description="Los espacios personales no tienen miembros. Conviértelo en organización desde Workspaces para invitar a tu equipo con roles." action={{ label: 'Ir a Workspaces', href: '/workspaces' }} />
      </>
    );
  }

  async function run(key: string, action: () => Promise<{ response: Response; error?: unknown }>, success: string) {
    setBusy(key);
    setNotice(null);
    try {
      const result = await action();
      if (!result.response.ok) {
        setNotice({ tone: 'error', text: apiErrorMessage(result.error, result.response.status) });
        return false;
      }
      setNotice({ tone: 'ok', text: success });
      void members.reload();
      void invitations.reload();
      return true;
    } catch {
      setNotice({ tone: 'error', text: NETWORK_ERROR_MESSAGE });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function sendInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run('invite', () => call((api) => api.POST('/users/invite', { body: { ...invite, email: invite.email.trim(), name: invite.name.trim() } })), `Invitación enviada a ${invite.email.trim()}.`);
    if (ok) {
      setDialog(null);
      setInvite({ name: '', email: '', role: 'LECTOR' });
    }
  }

  const data = members.data ?? [];
  const totalSessions = data.reduce((sum, member) => sum + member.sesionesActivas, 0);
  const count = (role: UserRole) => data.filter((member) => member.role === role).length;
  const pending: Invitation[] = invitations.data ?? [];

  return (
    <>
      <PageHeader
        trail={['Workspace', 'Equipo']}
        title="Usuarios y permisos"
        subtitle="Gestiona quién entra al workspace, con qué rol y desde qué sesiones."
        actions={
          <>
            <button className="button form-secondary page-action" type="button" onClick={() => setDialog({ kind: 'revoke-all' })}><Icon name="lock" size={14} />Cerrar todas las sesiones</button>
            <button className="button button--primary page-action" type="button" onClick={() => setDialog({ kind: 'invite' })}><Icon name="users" size={14} />Invitar usuario</button>
          </>
        }
      />

      <section className="kpi-grid" aria-label="Resumen del equipo">
        {[
          { title: 'Usuarios', value: data.length, icon: 'users' as const, footer: `${pending.length} invitaciones pendientes` },
          { title: 'Administradores', value: count('ADMIN'), icon: 'shield' as const, footer: 'Control total del workspace' },
          { title: 'Operadores y lectores', value: count('OPERADOR') + count('LECTOR'), icon: 'table' as const, footer: `${count('AUDITOR')} auditores` },
          { title: 'Sesiones activas', value: totalSessions, icon: 'activity' as const, footer: 'Dispositivos con sesión abierta' },
        ].map((kpi) => (
          <article className="surface-card kpi-card" key={kpi.title}>
            <header><span>{kpi.title}</span><Icon name={kpi.icon} size={16} /></header>
            <p className="kpi-value">{kpi.value}</p>
            <footer><span>{kpi.footer}</span></footer>
          </article>
        ))}
      </section>

      {notice && <p className={notice.tone === 'ok' ? 'page-notice' : 'form-error page-notice'} role="status">{notice.text}</p>}

      <section className="surface-card data-card team-card" aria-labelledby="members-title">
        <header className="data-card-header">
          <h2 id="members-title">Miembros</h2>
          <label className="search-field">
            <Icon name="search" size={14} />
            <input type="search" placeholder="Buscar por nombre o correo" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Buscar miembros" />
          </label>
          <select className="form-input compact-select" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as UserRole | '')} aria-label="Filtrar por rol">
            <option value="">Todos los roles</option>
            {ROLES.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
          </select>
        </header>
        {members.error && !members.data ? (
          <p className="form-error page-notice">{members.error}</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th>Sesiones</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
              <tbody>
                {list.map((member) => (
                  <tr key={member.id}>
                    <td><div className="cell-title"><span className="member-avatar">{initialsOf(member.name)}</span><span><strong>{member.name}{member.esUstedMismo && <small className="you-tag">Tú</small>}</strong><small className="cell-sub">{member.email}</small></span></div></td>
                    <td>
                      <select
                        className="form-input compact-select"
                        value={member.role}
                        disabled={member.esUstedMismo || busy === `role-${member.id}`}
                        aria-label={`Rol de ${member.name}`}
                        onChange={(event) => void run(`role-${member.id}`, () => call((api) => api.PATCH('/users/{id}/role', { params: { path: { id: member.id } }, body: { role: event.target.value as UserRole } })), `Rol de ${member.name} actualizado.`)}
                      >
                        {ROLES.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
                      </select>
                    </td>
                    <td><span className="status-pill" data-tone={member.bloqueado ? 'error' : 'ok'}><i />{member.bloqueado ? 'Bloqueado' : 'Activo'}</span></td>
                    <td>{lastAccess(member.ultimoAcceso)}</td>
                    <td>{member.sesionesActivas}</td>
                    <td className="cell-actions">
                      <button className="row-action" type="button" disabled={member.sesionesActivas === 0 || member.esUstedMismo || busy === `rev-${member.id}`} onClick={() => void run(`rev-${member.id}`, () => call((api) => api.POST('/users/{id}/sessions/revoke', { params: { path: { id: member.id } } })), `Sesiones de ${member.name} cerradas.`)}>Cerrar sesiones</button>
                      {!member.esUstedMismo && <button className="row-action row-action--danger" type="button" onClick={() => setDialog({ kind: 'remove', member })}>Quitar</button>}
                    </td>
                  </tr>
                ))}
                {pending.filter((invitation) => !roleFilter || invitation.role === roleFilter).map((invitation) => (
                  <tr key={invitation.id} className="row-pending">
                    <td><div className="cell-title"><span className="member-avatar member-avatar--pending">{initialsOf(invitation.name)}</span><span><strong>{invitation.name}</strong><small className="cell-sub">{invitation.email}</small></span></div></td>
                    <td>{roleLabels[invitation.role]}</td>
                    <td><span className="status-pill"><i />Invitado</span><small className="cell-sub">Vence {new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' }).format(new Date(invitation.expiresAt))}</small></td>
                    <td>—</td>
                    <td>—</td>
                    <td className="cell-actions">
                      <button className="row-action" type="button" disabled={busy === `res-${invitation.id}`} onClick={() => void run(`res-${invitation.id}`, () => call((api) => api.POST('/users/invitations/{id}/resend', { params: { path: { id: invitation.id } } })), `Invitación reenviada a ${invitation.email}.`)}>Reenviar</button>
                      <button className="row-action row-action--danger" type="button" disabled={busy === `del-${invitation.id}`} onClick={() => void run(`del-${invitation.id}`, () => call((api) => api.DELETE('/users/invitations/{id}', { params: { path: { id: invitation.id } } })), 'Invitación revocada.')}>Revocar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {members.isLoading && <p className="page-message">Cargando miembros…</p>}
          </div>
        )}
      </section>

      <section className="role-cards" aria-label="Qué puede hacer cada rol">
        {ROLES.map((role) => (
          <article key={role} className="surface-card role-card">
            <strong>{roleLabels[role]}</strong>
            <p>{ROLE_INFO[role].detail}</p>
            <ul>{ROLE_INFO[role].can.map((item) => <li key={item}><Icon name="check" size={12} />{item}</li>)}</ul>
          </article>
        ))}
      </section>

      {dialog?.kind === 'invite' && (
        <Modal
          title="Invitar usuario"
          description={workspace.data?.configuracion?.dominiosPermitidos?.length ? `Solo se admiten correos de: ${workspace.data.configuracion.dominiosPermitidos.join(', ')}` : 'Recibirá un enlace para crear su contraseña (válido 72 horas).'}
          onClose={() => setDialog(null)}
          footer={<><button className="button form-secondary" type="button" onClick={() => setDialog(null)}>Cancelar</button><button className="button button--primary form-primary" type="submit" form="invite-form" disabled={busy === 'invite'}>{busy === 'invite' ? 'Enviando…' : 'Enviar invitación'}</button></>}
        >
          <form id="invite-form" method="post" className="form-grid" onSubmit={sendInvite}>
            <label className="form-field"><span>Nombre</span><input className="form-input" required maxLength={120} value={invite.name} onChange={(event) => setInvite({ ...invite, name: event.target.value })} /></label>
            <label className="form-field"><span>Correo</span><input className="form-input" type="email" required value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} /></label>
            <fieldset className="engine-picker role-picker">
              <legend>Rol</legend>
              {ROLES.map((role) => (
                <label key={role} className="engine-option" data-selected={invite.role === role}>
                  <input type="radio" name="role" value={role} checked={invite.role === role} onChange={() => setInvite({ ...invite, role })} />
                  <span>{roleLabels[role]}<small>{ROLE_INFO[role].detail}</small></span>
                </label>
              ))}
            </fieldset>
            {notice?.tone === 'error' && <p className="form-error form-field--wide">{notice.text}</p>}
          </form>
        </Modal>
      )}
      {dialog?.kind === 'remove' && (
        <Modal
          title="Quitar del workspace"
          description={`${dialog.member.name} perderá el acceso y se cerrarán sus sesiones.`}
          onClose={() => setDialog(null)}
          footer={<><button className="button form-secondary" type="button" onClick={() => setDialog(null)}>Cancelar</button><button className="button form-danger" type="button" disabled={busy === 'remove'} onClick={() => void run('remove', () => call((api) => api.DELETE('/users/{id}', { params: { path: { id: dialog.member.id } } })), `${dialog.member.name} ya no forma parte del workspace.`).then((ok) => ok && setDialog(null))}>Quitar</button></>}
        >
          <p className="modal-text">Sus consultas guardadas y reportes se conservan. Puedes volver a invitarlo cuando quieras.</p>
        </Modal>
      )}
      {dialog?.kind === 'revoke-all' && (
        <Modal
          title="Cerrar todas las sesiones"
          description="Todos los miembros tendrán que volver a iniciar sesión. Tu sesión actual se mantiene."
          onClose={() => setDialog(null)}
          footer={<><button className="button form-secondary" type="button" onClick={() => setDialog(null)}>Cancelar</button><button className="button form-danger" type="button" disabled={busy === 'all'} onClick={() => void run('all', () => call((api) => api.POST('/users/sessions/revoke-all')), 'Se cerraron todas las sesiones del workspace salvo la tuya.').then((ok) => ok && setDialog(null))}>Cerrar sesiones</button></>}
        >
          <p className="modal-text">Úsalo ante un incidente de seguridad, por ejemplo si un equipo se perdió o una contraseña se filtró.</p>
        </Modal>
      )}
    </>
  );
}
