'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '@/components/icons';

type ModalProps = Readonly<{
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}>;

/** Diálogo modal reutilizable: se cierra con Escape, con la X o tocando fuera, y enfoca su primer campo. */
export function Modal({ title, description, onClose, children, footer, size = 'md' }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    dialogRef.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.modal-close)')?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" data-size={size} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialogRef}>
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="shell-icon-button modal-close" type="button" aria-label="Cerrar" onClick={onClose}><Icon name="close" size={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
