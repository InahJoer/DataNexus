'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Modal } from '@/components/app-shell/modal';
import { Icon } from '@/components/icons';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import type { components } from '@/lib/api/schema';

type JoinPayload = components['schemas']['CrossJoinDto'];

type SaveQueryModalProps = Readonly<{ definition: JoinPayload; columns: number; onClose: () => void; onSaved?: (query: { id: string; nombre: string }) => void }>;

/** Guarda el cruce (fuentes, relaciones y columnas elegidas) como consulta para reutilizarlo o programarlo. */
export function SaveQueryModal({ definition, columns, onClose, onSaved }: SaveQueryModalProps) {
  const call = useApiCall();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'PRIVADA' | 'PUBLICADA'>('PRIVADA');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      const { offset: _offset, ...definicion } = definition;
      const result = await call((api) =>
        api.POST('/queries', { body: { nombre: name.trim(), ...(description.trim() ? { descripcion: description.trim() } : {}), definicion, visibilidad: visibility } }),
      );
      if (!result.response.ok || !result.data) {
        setError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      setSaved(result.data.nombre);
      onSaved?.({ id: result.data.id, nombre: result.data.nombre });
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  }

  if (saved) {
    return (
      <Modal title="Consulta guardada" description={`"${saved}" quedó guardada con sus fuentes, relaciones y ${columns} columnas.`} onClose={onClose}
        footer={<><button className="button form-secondary" type="button" onClick={onClose}>Cerrar</button><Link className="button button--primary form-primary" href="/scheduled-tasks"><Icon name="clock" size={14} />Programar reporte</Link></>}>
        <p className="modal-text">Ahora puedes programarla para recibir el reporte por correo cada día, semana o mes.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Guardar consulta"
      description={`Se guardan las fuentes, las relaciones y las ${columns} columnas visibles en su orden.`}
      onClose={onClose}
      footer={<><button className="button form-secondary" type="button" onClick={onClose}>Cancelar</button><button className="button button--primary form-primary" type="submit" form="save-query-form" disabled={isSaving || !name.trim()}>{isSaving ? 'Guardando…' : 'Guardar'}</button></>}
    >
      <form id="save-query-form" method="post" className="form-grid" onSubmit={handleSubmit}>
        <label className="form-field form-field--wide"><span>Nombre</span><input className="form-input" required maxLength={120} placeholder="Ventas por cliente y producto" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="form-field form-field--wide"><span>Descripción (opcional)</span><input className="form-input" maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <div className="form-field form-field--wide">
          <span>Visibilidad</span>
          <div className="segmented" role="radiogroup" aria-label="Visibilidad">
            <button type="button" role="radio" aria-checked={visibility === 'PRIVADA'} aria-pressed={visibility === 'PRIVADA'} onClick={() => setVisibility('PRIVADA')}><Icon name="lock" size={12} />Privada</button>
            <button type="button" role="radio" aria-checked={visibility === 'PUBLICADA'} aria-pressed={visibility === 'PUBLICADA'} onClick={() => setVisibility('PUBLICADA')}><Icon name="users" size={12} />Publicada (los lectores pueden ejecutarla)</button>
          </div>
        </div>
        {error && <p className="form-error form-field--wide" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
