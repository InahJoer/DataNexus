'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AuthAlert } from '@/components/auth/auth-layout';
import { PasswordField } from '@/components/auth/password-field';
import { LoginError } from '@/components/auth-provider';
import { Icon } from '@/components/icons';
import { SESSION_IDLE_TIMEOUT_MS, takeLogoutReason, useAuth, type LogoutReason } from '@/lib/auth-context';

const LOGOUT_NOTICES: Record<Exclude<LogoutReason, 'manual'>, { title: string; detail: string }> = {
  inactividad: { title: 'Cerramos tu sesión por inactividad', detail: `Pasaron ${SESSION_IDLE_TIMEOUT_MS / 60_000} minutos sin actividad. Vuelve a iniciar sesión para continuar.` },
  expirada: { title: 'Tu sesión ha expirado', detail: 'Por seguridad, vuelve a iniciar sesión para continuar.' },
};

type FormError = { kind: 'credentials' | 'locked' | 'other'; message: string };

export function LoginForm() {
  const router = useRouter();
  const { login, session } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [notice, setNotice] = useState<(typeof LOGOUT_NOTICES)[keyof typeof LOGOUT_NOTICES] | null>(null);

  useEffect(() => {
    const reason = takeLogoutReason();
    if (reason && reason !== 'manual') setNotice(LOGOUT_NOTICES[reason]);
  }, []);

  useEffect(() => {
    if (session) router.replace('/workspaces');
  }, [session, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const remember = formData.get('remember') === 'on';

    setError(null);
    setIsSubmitting(true);
    try {
      await login({ email, password }, { remember });
      router.replace('/workspaces');
    } catch (caught) {
      const status = caught instanceof LoginError ? caught.status : null;
      const message = caught instanceof Error ? caught.message : 'No se pudo iniciar sesión.';
      setError({ kind: status === 401 ? 'credentials' : status === 423 ? 'locked' : 'other', message });
      setNotice(null);
    } finally {
      setIsSubmitting(false);
    }
  }

  const invalidCredentials = error?.kind === 'credentials';

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      {notice && <AuthAlert tone="warning" title={notice.title}>{notice.detail}</AuthAlert>}
      {error?.kind === 'locked' && <AuthAlert tone="error" title="Cuenta bloqueada temporalmente">{error.message}</AuthAlert>}

      <label className="field-label" htmlFor="email">Correo electrónico</label>
      <div className="input-wrap" data-invalid={invalidCredentials || undefined}>
        <Icon name="mail" size={17} className="input-icon" />
        <input
          id="email"
          name="email"
          type="email"
          placeholder="nombre@empresa.com"
          autoComplete="email"
          required
          aria-invalid={invalidCredentials || undefined}
        />
      </div>

      <div className="form-gap" />
      <PasswordField
        id="password"
        name="password"
        label="Contraseña"
        placeholder="••••••••••••"
        autoComplete="current-password"
        required
        invalid={invalidCredentials}
        aria-describedby={error && error.kind !== 'locked' ? 'login-error' : undefined}
      />
      {error && error.kind !== 'locked' && <p className="form-error" id="login-error" role="alert">{error.message}</p>}
      <Link className="auth-link auth-forgot" href="/forgot-password">¿Olvidaste tu contraseña?</Link>

      <label className="auth-checkbox">
        <input type="checkbox" name="remember" />
        <span>Mantener sesión en este dispositivo</span>
      </label>

      <button className="button button--primary login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Verificando…' : 'Iniciar sesión'} {!isSubmitting && <Icon name="arrow-right" size={17} />}
      </button>
      <p className="auth-support">¿Aún no tienes acceso? <a href="mailto:soporte@datanexus.app">Contacta a tu administrador</a></p>
    </form>
  );
}
