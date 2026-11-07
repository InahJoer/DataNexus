'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthAlert, AuthHeading } from '@/components/auth/auth-layout';
import { NewPasswordFields } from '@/components/auth/new-password-fields';
import { Icon } from '@/components/icons';
import { createApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useLinkToken } from '@/lib/use-link-token';

export function ResetPasswordForm() {
  const token = useLinkToken();
  const [password, setPassword] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (token === undefined) return <p className="auth-loading">Cargando…</p>;

  if (!token) {
    return (
      <>
        <AuthHeading title="Enlace no válido." description="Este enlace de recuperación está incompleto." />
        <AuthAlert tone="error" title="Falta el código del enlace">Abre el enlace completo del correo o solicita uno nuevo.</AuthAlert>
        <Link className="button button--primary login-submit" href="/forgot-password">Solicitar un enlace nuevo</Link>
      </>
    );
  }

  if (done) {
    return (
      <>
        <AuthHeading title="Contraseña actualizada." description="Ya puedes iniciar sesión con tu nueva contraseña." />
        <AuthAlert tone="success" title="Listo">Por seguridad, cerramos las sesiones que tenías abiertas en otros dispositivos.</AuthAlert>
        <Link className="button button--primary login-submit" href="/login">Iniciar sesión <Icon name="arrow-right" size={17} /></Link>
      </>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !password) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await createApiClient().POST('/auth/reset-password', { body: { token, newPassword: password } });
      if (!result.response.ok) {
        setError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      setDone(true);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <AuthHeading title="Crea una contraseña nueva." description="Elige una contraseña segura que no uses en otros servicios." />
      <form className="login-form" onSubmit={handleSubmit}>
        <NewPasswordFields onChange={setPassword} />
        {error && (
          <AuthAlert tone="error" title="No se pudo restablecer la contraseña">
            {error} <Link className="auth-link" href="/forgot-password">Solicitar un enlace nuevo</Link>
          </AuthAlert>
        )}
        <button className="button button--primary login-submit" type="submit" disabled={isSubmitting || !password}>
          {isSubmitting ? 'Guardando…' : 'Guardar contraseña'}
        </button>
        <Link className="auth-link auth-back" href="/login"><Icon name="arrow-left" size={15} />Volver a iniciar sesión</Link>
      </form>
    </>
  );
}
