'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { useAuth } from '@/lib/auth-context';

export function LoginForm() {
  const router = useRouter();
  const { login, session } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (session) router.replace('/workspaces');
  }, [session, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');

    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await login({ email, password });
      router.replace('/workspaces');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'No se pudo iniciar sesión.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <label className="field-label" htmlFor="email">Correo electrónico</label>
      <div className="input-wrap">
        <Icon name="mail" size={17} className="input-icon" />
        <input
          id="email"
          name="email"
          type="email"
          placeholder="nombre@empresa.com"
          autoComplete="email"
          required
          aria-invalid={Boolean(errorMessage)}
        />
      </div>

      <div className="password-label-row">
        <label className="field-label" htmlFor="password">Contraseña</label>
        <span className="field-hint">Mínimo 6 caracteres</span>
      </div>
      <div className="input-wrap">
        <Icon name="lock" size={17} className="input-icon" />
        <input
          id="password"
          name="password"
          type={showPassword ? 'text' : 'password'}
          placeholder="••••••••••••"
          autoComplete="current-password"
          minLength={6}
          required
          aria-invalid={Boolean(errorMessage)}
          aria-describedby={errorMessage ? 'login-error' : undefined}
        />
        <button
          className="password-toggle"
          type="button"
          aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          onClick={() => setShowPassword((visible) => !visible)}
        >
          <Icon name={showPassword ? 'eye-off' : 'eye'} size={17} />
        </button>
      </div>

      {errorMessage && <p className="form-error" id="login-error" role="alert">{errorMessage}</p>}
      <button className="button button--primary login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Verificando…' : 'Continuar'} {!isSubmitting && <Icon name="arrow-right" size={17} />}
      </button>
      <p className="demo-note">Acceso validado de forma segura con DataNexus.</p>
    </form>
  );
}
