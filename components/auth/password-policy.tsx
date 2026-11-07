import { Icon } from '@/components/icons';

/**
 * Reglas de la política de contraseñas del backend (backend/src/auth/validators/password-policy.ts, RF-01). Aquí solo
 * guían al usuario mientras escribe; el backend vuelve a validarlas y su mensaje es el que manda.
 */
const RULES: readonly { label: string; test: (password: string) => boolean }[] = [
  { label: 'Entre 10 y 72 caracteres', test: (p) => p.length >= 10 && new TextEncoder().encode(p).length <= 72 },
  { label: 'Una letra mayúscula', test: (p) => /[A-ZÑÁÉÍÓÚ]/.test(p) },
  { label: 'Una letra minúscula', test: (p) => /[a-zñáéíóú]/.test(p) },
  { label: 'Un número', test: (p) => /\d/.test(p) },
  { label: 'Un símbolo (! @ # $ %…)', test: (p) => /[^A-Za-z0-9ñÑáéíóúÁÉÍÓÚ\s]/.test(p) },
];

export function passwordMeetsPolicy(password: string): boolean {
  return RULES.every((rule) => rule.test(password)) && !/^\s|\s$/.test(password);
}

export function PasswordPolicy({ password, id }: Readonly<{ password: string; id: string }>) {
  return (
    <ul className="password-policy" id={id} aria-label="Requisitos de la contraseña">
      {RULES.map((rule) => {
        const ok = rule.test(password);
        return (
          <li key={rule.label} data-ok={ok}>
            <Icon name={ok ? 'check' : 'close'} size={12} />
            <span>{rule.label}</span>
            <span className="visually-hidden">{ok ? '(cumplido)' : '(pendiente)'}</span>
          </li>
        );
      })}
      <li className="password-policy-note">Sin tu correo ni contraseñas comunes.</li>
    </ul>
  );
}
