'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import { useWorkspace } from '@/components/app-shell/workspace-context';

type Notice = Readonly<{ id: string; title: string; detail: string; href?: string }>;

const SERVICE_STATES: Record<string, string> = { DEGRADADO: 'funciona con problemas', CAIDO: 'no responde' };

/** Avisos del entorno que salen del resumen del workspace: conexiones caídas y servicios con problemas. */
function useNotices(): Notice[] {
  const { summary } = useWorkspace();
  const data = summary.data;
  if (!data) return [];
  const connections = (data.conexiones?.requierenAtencion ?? []).map((connection) => ({
    id: `connection-${connection.id}`,
    title: `${connection.nombre} necesita atención`,
    detail: 'El último health check de la conexión falló.',
    href: '/connections',
  }));
  const services = data.entorno.servicios
    .filter((service) => service.estado in SERVICE_STATES)
    .map((service) => ({
      id: `service-${service.servicio}`,
      title: `${service.servicio} ${SERVICE_STATES[service.estado]}`,
      detail: service.detalle,
    }));
  return [...connections, ...services];
}

export function NotificationsMenu() {
  const notices = useNotices();
  const [isOpen, setIsOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const label = notices.length > 0 ? `Notificaciones (${notices.length} sin revisar)` : 'Notificaciones';

  return (
    <div className="shell-notifications" ref={rootRef}>
      <button
        className="shell-icon-button"
        type="button"
        aria-label={label}
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Icon name="bell" size={16} />
        {notices.length > 0 && <i className="shell-notification-dot" aria-hidden="true" />}
      </button>
      {isOpen && (
        <div className="shell-popover" id={menuId} role="dialog" aria-label="Notificaciones">
          <p className="shell-popover-title">Notificaciones</p>
          {notices.length === 0 ? (
            <p className="shell-popover-empty">Todo en orden. No hay avisos del entorno.</p>
          ) : (
            <ul>
              {notices.map((notice) => (
                <li key={notice.id}>
                  <Icon name="alert" size={15} />
                  <div>
                    <strong>{notice.title}</strong>
                    <span>{notice.detail}</span>
                    {notice.href && <Link href={notice.href} onClick={() => setIsOpen(false)}>Revisar</Link>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
