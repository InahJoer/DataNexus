'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { initialsOf } from '@/components/app-shell/format';
import { PageHeader } from '@/components/app-shell/page-header';
import { useWorkspace } from '@/components/app-shell/workspace-context';
import { NewPasswordFields } from '@/components/auth/new-password-fields';
import { PasswordField } from '@/components/auth/password-field';
import { Icon } from '@/components/icons';
import type { ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useApiQuery } from '@/lib/api/use-api-query';
import { roleLabels, useAuth } from '@/lib/auth-context';
import { readTheme, saveTheme, type ThemePreference } from '@/lib/theme';

type Notice = { tone: 'ok' | 'error'; text: string } | null;

/** "Chrome 130 en Windows" a partir del user agent. */
function deviceOf(userAgent: string | null) {
  if (!userAgent) return 'Dispositivo desconocido';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Navegador';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Mac OS/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : '';
  return os ? `${browser} en ${os}` : browser;
}

const dateTime = (value: string) => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

/** Perfil y preferencias de seguridad (#72). */
export default function ProfilePage() {
  const call = useApiCall();
  const { session } = useAuth();
  const { workspace } = useWorkspace();
  const sessions = useApiQuery(useCallback((api: ApiClient) => api.GET('/auth/sessions'), []));
  const [name, setName] = useState(session?.user.name ?? '');
  const [savedName, setSavedName] = useState(session?.user.name ?? '');
  const [profileNotice, setProfileNotice] = useState<Notice>(null);
  const [current, setCurrent] = useState('');
  const [nextPassword, setNextPassword] = useState<string | null>(null);
  const [passwordKey, setPasswordKey] = useState(0);
  const [passwordNotice, setPasswordNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePreference>('light');

  useEffect(() => setTheme(readTheme()), []);
  if (!session) return null;
  const { user } = session;

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('profile');
    setProfileNotice(null);
    try {
      const result = await call((api) => api.PATCH('/auth/profile', { body: { name } }));
      if (!result.response.ok || !result.data) {
        setProfileNotice({ tone: 'error', text: apiErrorMessage(result.error, result.response.status) });
        return;
      }
      setSavedName(result.data.name);
      setName(result.data.name);
      setProfileNotice({ tone: 'ok', text: 'Datos guardados. Se verán en el menú la próxima vez que inicies sesión.' });
    } catch {
      setProfileNotice({ tone: 'error', text: NETWORK_ERROR_MESSAGE });
    } finally {
      setBusy(null);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nextPassword) return;
    setBusy('password');
    setPasswordNotice(null);
    try {
      const result = await call((api) => api.POST('/auth/change-password', { body: { currentPassword: current, newPassword: nextPassword } }));
      if (!result.response.ok) {
        setPasswordNotice({ tone: 'error', text: apiErrorMessage(result.error, result.response.status) });
        return;
      }
      setCurrent('');
      setNextPassword(null);
      setPasswordKey((key) => key + 1);
      setPasswordNotice({ tone: 'ok', text: 'Contraseña actualizada. Cerramos tus otras sesiones abiertas.' });
      void sessions.reload();
    } catch {
      setPasswordNotice({ tone: 'error', text: NETWORK_ERROR_MESSAGE });
    } finally {
      setBusy(null);
    }
  }

  async function closeSession(id: string) {
    setBusy(id);
    try {
      const result = await call((api) => api.DELETE('/auth/sessions/{id}', { params: { path: { id } } }));
      if (result.response.ok) void sessions.reload();
    } finally {
      setBusy(null);
    }
  }

  function chooseTheme(preference: ThemePreference) {
    setTheme(preference);
    saveTheme(preference);
  }

  return (
    <>
      <PageHeader trail={['Cuenta', 'Mi perfil']} title="Perfil y seguridad" subtitle="Tus datos personales, tu contraseña y los dispositivos con sesión abierta." />

      <div className="profile-grid">
        <section className="surface-card panel-card" aria-labelledby="personal-title">
          <header className="panel-header"><div><h2 id="personal-title">Datos personales</h2><p>El correo no se puede cambiar porque es tu usuario para entrar.</p></div></header>
          <div className="profile-identity">
            <span className="member-avatar member-avatar--lg">{initialsOf(savedName)}</span>
            <div><strong>{savedName}</strong><span>{roleLabels[user.role]} · {workspace.data?.nombreEmpresa ?? 'Workspace'}</span></div>
          </div>
          <form method="post" className="form-grid" onSubmit={saveProfile}>
            <label className="form-field form-field--wide"><span>Nombre y apellidos</span><input className="form-input" required minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className="form-field"><span>Correo</span><input className="form-input" value={user.email} readOnly aria-readonly /></label>
            <label className="form-field"><span>Rol</span><input className="form-input" value={roleLabels[user.role]} readOnly aria-readonly /></label>
            <div className="form-field--wide form-actions">
              {profileNotice && <span className={profileNotice.tone === 'ok' ? 'page-notice' : 'form-error'}>{profileNotice.text}</span>}
              <button className="button button--primary form-primary" type="submit" disabled={busy === 'profile' || name.trim() === savedName}>Guardar</button>
            </div>
          </form>
        </section>

        <section className="surface-card panel-card" aria-labelledby="password-title">
          <header className="panel-header"><div><h2 id="password-title">Cambiar contraseña</h2><p>Al cambiarla se cierran tus otras sesiones abiertas.</p></div></header>
          <form method="post" className="login-form" onSubmit={changePassword} key={passwordKey}>
            <PasswordField id="current-password" name="currentPassword" label="Contraseña actual" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} />
            <div className="form-gap" />
            <NewPasswordFields onChange={setNextPassword} />
            {passwordNotice && <p className={passwordNotice.tone === 'ok' ? 'page-notice' : 'form-error'} role="status">{passwordNotice.text}</p>}
            <button className="button button--primary form-primary profile-submit" type="submit" disabled={busy === 'password' || !nextPassword || !current}>{busy === 'password' ? 'Guardando…' : 'Cambiar contraseña'}</button>
          </form>
        </section>

        <section className="surface-card panel-card" aria-labelledby="sessions-title">
          <header className="panel-header"><div><h2 id="sessions-title">Sesiones abiertas</h2><p>Si no reconoces un dispositivo, cierra su sesión y cambia tu contraseña.</p></div></header>
          <ul className="session-list">
            {(sessions.data ?? []).map((item) => (
              <li key={item.id}>
                <span className="recent-icon"><Icon name={item.actual ? 'check' : 'lock'} size={15} /></span>
                <div><strong>{deviceOf(item.userAgent)}{item.actual && <small className="you-tag">Esta sesión</small>}</strong><small>{item.ipAddress ?? 'IP desconocida'} · activa {dateTime(item.lastActivityAt)} · desde {dateTime(item.createdAt)}</small></div>
                {!item.actual && <button className="row-action row-action--danger" type="button" disabled={busy === item.id} onClick={() => void closeSession(item.id)}>Cerrar</button>}
              </li>
            ))}
          </ul>
          {sessions.isLoading && <p className="panel-empty">Cargando sesiones…</p>}
        </section>

        <section className="surface-card panel-card" aria-labelledby="theme-title">
          <header className="panel-header"><div><h2 id="theme-title">Apariencia</h2><p>Se guarda en este dispositivo.</p></div></header>
          <div className="segmented theme-picker" role="radiogroup" aria-label="Tema">
            {([['light', 'Claro'], ['dark', 'Oscuro'], ['system', 'Según el sistema']] as const).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={theme === value} aria-pressed={theme === value} onClick={() => chooseTheme(value)}>{label}</button>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
