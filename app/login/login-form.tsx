'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';

export function LoginForm() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    router.push('/workspaces');
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

      <button className="button button--primary login-submit" type="submit">
        Continuar <Icon name="arrow-right" size={17} />
      </button>
      <p className="demo-note">Prototipo de diseño · cualquier correo y contraseña válidos funcionan.</p>
    </form>
  );
}
