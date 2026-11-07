'use client';

import { useState, type FormEvent } from 'react';
import { Modal } from '@/components/app-shell/modal';
import type { Workspace } from '@/components/app-shell/workspace-context';
import { Icon } from '@/components/icons';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';

type WorkspaceSettingsModalProps = Readonly<{ workspace: Workspace; onClose: () => void; onSaved: () => void }>;

/** Edición del workspace (ADMIN): nombre, descripción, zona horaria, dominios permitidos y paso a organización. */
export function WorkspaceSettingsModal({ workspace, onClose, onSaved }: WorkspaceSettingsModalProps) {
  const call = useApiCall();
  const [name, setName] = useState(workspace.nombreEmpresa);
  const [description, setDescription] = useState(workspace.descripcion ?? '');
  const [timeZone, setTimeZone] = useState(workspace.zonaHoraria);
  const [domains, setDomains] = useState((workspace.configuracion?.dominiosPermitidos ?? []).join(', '));
  const [convert, setConvert] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isPersonal = workspace.tipoCuenta === 'PERSONAL';
  const showDomains = !isPersonal || convert;
  const timeZones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [workspace.zonaHoraria];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      const result = await call((api) =>
        api.PATCH('/workspaces/me', {
          body: {
            nombreEmpresa: name.trim(),
            descripcion: description.trim() || null,
            zonaHoraria: timeZone,
            ...(showDomains ? { dominiosPermitidos: domains.split(',').map((domain) => domain.trim()).filter(Boolean) } : {}),
            ...(convert ? { tipoCuenta: 'ORGANIZACION' as const } : {}),
          },
        }),
      );
      if (!result.response.ok) {
        setError(apiErrorMessage(result.error, result.response.status));
        return;
      }
      onSaved();
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      title="Editar workspace"
      description="Los cambios quedan registrados en la bitácora de auditoría."
      onClose={onClose}
      footer={
        <>
          <button className="button form-secondary" type="button" onClick={onClose}>Cancelar</button>
          <button className="button button--primary form-primary" type="submit" form="workspace-form" disabled={isSaving}>{isSaving ? 'Guardando…' : 'Guardar cambios'}</button>
        </>
      }
    >
      <form id="workspace-form" method="post" className="form-grid" onSubmit={handleSubmit}>
        <label className="form-field form-field--wide">
          <span>{isPersonal && !convert ? 'Nombre del espacio' : 'Nombre de la organización'}</span>
          <input className="form-input" required minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="form-field form-field--wide">
          <span>Descripción (opcional)</span>
          <input className="form-input" maxLength={280} placeholder="Datos de ventas y logística" value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="form-field form-field--wide">
          <span>Zona horaria (fechas y reportes programados)</span>
          <select className="form-input" value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
            {[...new Set([workspace.zonaHoraria, ...timeZones])].map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </label>
        {isPersonal && (
          <label className="form-check form-field--wide convert-check">
            <input type="checkbox" checked={convert} onChange={(event) => setConvert(event.target.checked)} />
            <span><strong>Convertir en organización</strong> para invitar a tu equipo con roles. No se puede volver a personal.</span>
          </label>
        )}
        {showDomains && (
          <label className="form-field form-field--wide">
            <span>Dominios permitidos para invitar (separados por comas)</span>
            <input className="form-input" placeholder="empresa.com, filial.com" value={domains} onChange={(event) => setDomains(event.target.value)} />
            <small className="field-help"><Icon name="lock" size={11} /> Vacío = cualquier dominio corporativo. Los correos personales (Gmail, Hotmail…) nunca se aceptan.</small>
          </label>
        )}
        {error && <p className="form-error form-field--wide" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
