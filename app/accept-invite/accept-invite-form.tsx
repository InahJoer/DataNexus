'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthAlert, AuthHeading } from '@/components/auth/auth-layout';
import { NewPasswordFields } from '@/components/auth/new-password-fields';
import { Icon } from '@/components/icons';
import { createApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { roleLabels } from '@/lib/auth-context';
import type { components } from '@/lib/api/schema';
import { useLinkToken } from '@/lib/use-link-token';

type Invitation = components['schemas']['InvitationPreviewDto'];
type Preview = { state: 'loading' } | { state: 'invalid'; message: string } | { state: 'ready'; invitation: Invitation };

/** "Acme S.A." + "." no debe quedar como "Acme S.A..". */
const withoutTrailingDot = (text: string) => text.replace(/\.+$/, '');

const dateFormat = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export function AcceptInviteForm() {
  const token = useLinkToken();
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const [name, setName] = useState('');
  const [password, setPassword] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (token === undefined) return;
    if (!token) {
      setPreview({ state: 'invalid', message: 'El enlace está incompleto. Abre el enlace completo del correo.' });
      return;
    }
    let active = true;
    createApiClient()
      .POST('/auth/invitation-preview', { body: { token } })
      .then((result) => {
        if (!active) return;
        if (!result.response.ok || !result.data) {
          setPreview({ state: 'invalid', message: apiErrorMessage(result.error, result.response.status) });
          return;
        }
        setPreview({ state: 'ready', invitation: result.data });
        setName(result.data.name);
      })
      .catch(() => active && setPreview({ state: 'invalid', message: NETWORK_ERROR_MESSAGE }));
    return () => {
      active = false;
    };
  }, [token]);

  if (preview.state === 'loading') return <p className="auth-loading">Cargando invitación…</p>;

  if (preview.state === 'invalid') {
    return (
      <>
        <AuthHeading title="Invitación no disponible." description="No pudimos abrir esta invitación." />
        <AuthAlert tone="error" title="El enlace no es válido">
          {preview.message} Pide a un administrador de tu workspace que te envíe una nueva.
        </AuthAlert>
        <Link className="auth-link auth-back" href="/login"><Icon name="arrow-left" size={15} />Ir a iniciar sesión</Link>
      </>
    );
  }

  const { invitation } = preview;

  if (accepted) {
    return (
      <>
        <AuthHeading title="Tu cuenta está lista." description={`Ya formas parte de ${withoutTrailingDot(invitation.nombreEmpresa)}.`} />
        <AuthAlert tone="success" title="Invitación aceptada">Inicia sesión con {invitation.email} y la contraseña que acabas de crear.</AuthAlert>
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
      const trimmed = name.trim();
      const result = await createApiClient().POST('/auth/accept-invite', {
        body: { token, password, ...(trimmed ? { name: trimmed } : {}) },
      });
      if (!result.response.ok) {
        setError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      setAccepted(true);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <AuthHeading
        eyebrow="INVITACIÓN"
        title={`Únete a ${withoutTrailingDot(invitation.nombreEmpresa)}.`}
        description="Crea tu contraseña para activar tu cuenta."
      />
      <dl className="invite-summary">
        <div><dt>Correo</dt><dd>{invitation.email}</dd></div>
        <div><dt>Tu rol</dt><dd>{roleLabels[invitation.role]}</dd></div>
        <div><dt>Vence</dt><dd>{dateFormat.format(new Date(invitation.expiresAt))}</dd></div>
      </dl>
      <form method="post" className="login-form" onSubmit={handleSubmit}>
        <label className="field-label" htmlFor="name">Nombre</label>
        <div className="input-wrap">
          <Icon name="user" size={17} className="input-icon" />
          <input id="name" name="name" autoComplete="name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="form-gap" />
        <NewPasswordFields onChange={setPassword} />
        {error && <AuthAlert tone="error" title="No se pudo aceptar la invitación">{error}</AuthAlert>}
        <button className="button button--primary login-submit" type="submit" disabled={isSubmitting || !password || !name.trim()}>
          {isSubmitting ? 'Creando cuenta…' : 'Aceptar invitación'} {!isSubmitting && <Icon name="arrow-right" size={17} />}
        </button>
      </form>
    </>
  );
}
