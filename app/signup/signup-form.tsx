'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthAlert, AuthHeading } from '@/components/auth/auth-layout';
import { NewPasswordFields } from '@/components/auth/new-password-fields';
import { LoginError } from '@/components/auth-provider';
import { Icon, type IconName } from '@/components/icons';
import { useAuth } from '@/lib/auth-context';

type AccountType = 'PERSONAL' | 'ORGANIZACION';

/** Dominios de correo personal más comunes: en una organización se avisa antes de enviar (la API lo valida igual). */
const PERSONAL_DOMAINS = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'live.com', 'icloud.com', 'proton.me', 'protonmail.com'];

const TYPES: Record<AccountType, { title: string; subtitle: string; icon: IconName; points: string[] }> = {
  PERSONAL: {
    title: 'Uso personal',
    subtitle: 'Para ti: proyectos propios, estudios o análisis individuales.',
    icon: 'user',
    points: ['Con cualquier correo', 'Tu propio espacio, sin equipo', 'Puedes convertirlo en organización cuando quieras'],
  },
  ORGANIZACION: {
    title: 'Organización',
    subtitle: 'Para equipos y empresas que comparten conexiones y reportes.',
    icon: 'users',
    points: ['Con correo corporativo', 'Invita a tu equipo con roles y permisos', 'Solo se invita a correos de tu dominio'],
  },
};

/** Alta de cuenta: primero se elige el tipo (personal u organización) y después se completan los datos. */
export function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signup, session } = useAuth();
  const [type, setType] = useState<AccountType | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [organization, setOrganization] = useState('');
  const [password, setPassword] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const requested = searchParams.get('tipo');
    if (requested === 'personal') setType('PERSONAL');
    if (requested === 'organizacion') setType('ORGANIZACION');
  }, [searchParams]);

  useEffect(() => {
    if (session) router.replace('/workspaces');
  }, [session, router]);

  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const personalEmail = type === 'ORGANIZACION' && PERSONAL_DOMAINS.includes(domain);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!type || !password || personalEmail) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await signup(
        {
          tipoCuenta: type,
          name: name.trim(),
          email: email.trim(),
          password,
          ...(type === 'ORGANIZACION' ? { nombreEmpresa: organization.trim() } : {}),
          zonaHoraria: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        { remember },
      );
      router.replace('/workspaces');
    } catch (caught) {
      setError(caught instanceof LoginError || caught instanceof Error ? caught.message : 'No se pudo crear la cuenta.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!type) {
    return (
      <>
        <AuthHeading eyebrow="CREAR CUENTA" title="¿Cómo vas a usar DataNexus?" description="Elige el tipo de cuenta. Podrás pasar de personal a organización más adelante." />
        <div className="account-types" role="list">
          {(Object.keys(TYPES) as AccountType[]).map((key) => (
            <button key={key} type="button" role="listitem" className="account-type" onClick={() => setType(key)}>
              <span className="account-type-icon"><Icon name={TYPES[key].icon} size={20} /></span>
              <span className="account-type-copy">
                <strong>{TYPES[key].title}</strong>
                <span>{TYPES[key].subtitle}</span>
                <ul>{TYPES[key].points.map((point) => <li key={point}><Icon name="check" size={12} />{point}</li>)}</ul>
              </span>
              <Icon name="arrow-right" size={16} />
            </button>
          ))}
        </div>
        <p className="auth-support">¿Ya tienes cuenta? <Link href="/login">Inicia sesión</Link></p>
      </>
    );
  }

  const info = TYPES[type];
  return (
    <>
      <button type="button" className="auth-link auth-back account-change" onClick={() => setType(null)}>
        <Icon name="arrow-left" size={15} />Cambiar tipo de cuenta
      </button>
      <AuthHeading eyebrow={info.title.toUpperCase()} title={type === 'PERSONAL' ? 'Crea tu espacio personal.' : 'Crea tu organización.'} description={info.subtitle} />
      <form method="post" className="login-form" onSubmit={handleSubmit}>
        {type === 'ORGANIZACION' && (
          <>
            <label className="field-label" htmlFor="organization">Nombre de la organización</label>
            <div className="input-wrap">
              <Icon name="layers" size={17} className="input-icon" />
              <input id="organization" name="organization" required maxLength={120} placeholder="Acme Analytics S.A." value={organization} onChange={(event) => setOrganization(event.target.value)} />
            </div>
            <div className="form-gap" />
          </>
        )}
        <label className="field-label" htmlFor="name">Tu nombre</label>
        <div className="input-wrap">
          <Icon name="user" size={17} className="input-icon" />
          <input id="name" name="name" required minLength={2} maxLength={120} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="form-gap" />
        <label className="field-label" htmlFor="email">{type === 'ORGANIZACION' ? 'Correo corporativo' : 'Correo electrónico'}</label>
        <div className="input-wrap" data-invalid={personalEmail || undefined}>
          <Icon name="mail" size={17} className="input-icon" />
          <input id="email" name="email" type="email" required autoComplete="email" placeholder={type === 'ORGANIZACION' ? 'nombre@empresa.com' : 'nombre@correo.com'} value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={personalEmail || undefined} />
        </div>
        {personalEmail && (
          <p className="form-error">Las organizaciones necesitan un correo de su dominio. ¿Es para ti solo? <button type="button" className="auth-link inline-link" onClick={() => setType('PERSONAL')}>Crea una cuenta personal</button></p>
        )}
        {type === 'ORGANIZACION' && domain && !personalEmail && (
          <p className="field-help">Solo se podrá invitar a correos <strong>@{domain}</strong>. Podrás agregar más dominios después.</p>
        )}
        <div className="form-gap" />
        <NewPasswordFields onChange={setPassword} />
        <label className="auth-checkbox">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>Mantener sesión en este dispositivo</span>
        </label>
        {error && <AuthAlert tone="error" title="No se pudo crear la cuenta">{error}</AuthAlert>}
        <button className="button button--primary login-submit" type="submit" disabled={isSubmitting || !password || personalEmail}>
          {isSubmitting ? 'Creando cuenta…' : 'Crear cuenta'} {!isSubmitting && <Icon name="arrow-right" size={17} />}
        </button>
        <p className="auth-support">¿Ya tienes cuenta? <Link href="/login">Inicia sesión</Link></p>
      </form>
    </>
  );
}
