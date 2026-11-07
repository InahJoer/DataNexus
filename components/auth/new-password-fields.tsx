'use client';

import { useState } from 'react';
import { PasswordField } from '@/components/auth/password-field';
import { PasswordPolicy, passwordMeetsPolicy } from '@/components/auth/password-policy';

/**
 * Nueva contraseña + confirmación con la política a la vista. Avisa con `onChange` la contraseña cuando cumple la
 * política y coincide con la confirmación, o null mientras no.
 */
export function NewPasswordFields({ onChange }: Readonly<{ onChange: (password: string | null) => void }>) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const mismatch = confirmation.length > 0 && confirmation !== password;

  function update(nextPassword: string, nextConfirmation: string) {
    setPassword(nextPassword);
    setConfirmation(nextConfirmation);
    onChange(passwordMeetsPolicy(nextPassword) && nextPassword === nextConfirmation ? nextPassword : null);
  }

  return (
    <>
      <PasswordField
        id="new-password"
        name="newPassword"
        label="Nueva contraseña"
        autoComplete="new-password"
        required
        value={password}
        onChange={(event) => update(event.target.value, confirmation)}
        aria-describedby="password-policy"
      />
      <PasswordPolicy id="password-policy" password={password} />
      <PasswordField
        id="confirm-password"
        name="confirmation"
        label="Confirma la contraseña"
        autoComplete="new-password"
        required
        value={confirmation}
        onChange={(event) => update(password, event.target.value)}
        invalid={mismatch}
        aria-describedby={mismatch ? 'confirm-error' : undefined}
      />
      {mismatch && <p className="form-error" id="confirm-error">Las contraseñas no coinciden.</p>}
    </>
  );
}
