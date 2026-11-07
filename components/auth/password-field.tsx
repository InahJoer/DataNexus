'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { Icon } from '@/components/icons';

type PasswordFieldProps = Readonly<
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & { id: string; label: string; invalid?: boolean }
>;

/** Campo de contraseña con botón para mostrarla u ocultarla. */
export function PasswordField({ id, label, invalid, ...inputProps }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="input-wrap" data-invalid={invalid || undefined}>
        <Icon name="lock" size={17} className="input-icon" />
        <input id={id} type={visible ? 'text' : 'password'} aria-invalid={invalid || undefined} {...inputProps} />
        <button
          className="password-toggle"
          type="button"
          aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          onClick={() => setVisible((value) => !value)}
        >
          <Icon name={visible ? 'eye-off' : 'eye'} size={17} />
        </button>
      </div>
    </>
  );
}
