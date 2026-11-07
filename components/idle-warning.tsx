'use client';

import { useEffect, useRef } from 'react';
import { Icon } from '@/components/icons';
import { useAuth } from '@/lib/auth-context';

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Aviso antes del cierre automático por inactividad (RF-04): cuenta regresiva y "Seguir conectado". */
export function IdleWarning() {
  const { idleSecondsLeft, stayActive, logout } = useAuth();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isOpen = idleSecondsLeft !== null;

  useEffect(() => {
    if (isOpen) buttonRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="idle-overlay">
      <section className="idle-dialog" role="alertdialog" aria-modal="true" aria-labelledby="idle-title" aria-describedby="idle-description">
        <span className="idle-icon"><Icon name="clock" size={20} /></span>
        <h2 id="idle-title">¿Sigues ahí?</h2>
        <p id="idle-description">
          Por seguridad, tu sesión se cerrará por inactividad en <strong aria-live="polite">{formatCountdown(idleSecondsLeft)}</strong>.
        </p>
        <div className="idle-actions">
          <button className="button idle-secondary" type="button" onClick={() => logout('manual')}>Cerrar sesión</button>
          <button className="button button--primary" type="button" ref={buttonRef} onClick={stayActive}>Seguir conectado</button>
        </div>
      </section>
    </div>
  );
}
