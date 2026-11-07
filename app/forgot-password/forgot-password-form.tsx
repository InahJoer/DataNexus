'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthAlert, AuthHeading } from '@/components/auth/auth-layout';
import { Icon } from '@/components/icons';
import { createApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';

export function ForgotPasswordForm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await createApiClient().POST('/auth/forgot-password', { body: { email } });
      if (!result.response.ok) {
        setError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      setSentTo(email);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (sentTo) {
    return (
      <>
        <AuthHeading title="Revisa tu correo." description="Te enviamos las instrucciones para crear una contraseña nueva." />
        {/* El backend responde igual exista o no la cuenta, para no revelar qué correos están registrados. */}
        <AuthAlert tone="success" title="Solicitud recibida">
          Si {sentTo} está registrado, recibirás un enlace válido durante 30 minutos. Revisa también la carpeta de spam.
        </AuthAlert>
        <Link className="button button--primary login-submit" href="/login"><Icon name="arrow-left" size={17} />Volver a iniciar sesión</Link>
      </>
    );
  }

  return (
    <>
      <AuthHeading title="¿Olvidaste tu contraseña?" description="Escribe el correo de tu cuenta y te enviaremos un enlace para restablecerla." />
      <form className="login-form" onSubmit={handleSubmit}>
        <label className="field-label" htmlFor="email">Correo electrónico</label>
        <div className="input-wrap">
          <Icon name="mail" size={17} className="input-icon" />
          <input id="email" name="email" type="email" placeholder="nombre@empresa.com" autoComplete="email" required />
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button--primary login-submit" type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Enviando…' : 'Enviar enlace'} {!isSubmitting && <Icon name="arrow-right" size={17} />}
        </button>
        <Link className="auth-link auth-back" href="/login"><Icon name="arrow-left" size={15} />Volver a iniciar sesión</Link>
      </form>
    </>
  );
}
