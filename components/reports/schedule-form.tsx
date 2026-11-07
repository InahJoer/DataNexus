'use client';

import Link from 'next/link';
import { useCallback, useState, type FormEvent } from 'react';
import { Modal } from '@/components/app-shell/modal';
import { useWorkspace } from '@/components/app-shell/workspace-context';
import { Icon } from '@/components/icons';
import { asNumber, cronPreview, DAYS, FORMAT_LABELS, type ReportFormat, type Schedule } from '@/components/reports/report-helpers';
import type { ApiClient } from '@/lib/api/client';
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import { useApiCall } from '@/lib/api/use-api-call';
import { useApiQuery } from '@/lib/api/use-api-query';

type ScheduleFormProps = Readonly<{ schedule?: Schedule; onClose: () => void; onSaved: () => void }>;

/** Alta y edición de una tarea programada (#70): consulta guardada, frecuencia, hora, zona horaria, formato y envío. */
export function ScheduleForm({ schedule, onClose, onSaved }: ScheduleFormProps) {
  const call = useApiCall();
  const { workspace } = useWorkspace();
  const queries = useApiQuery(useCallback((api: ApiClient) => api.GET('/queries'), []));
  const [title, setTitle] = useState(schedule?.reportTitle ?? '');
  const [queryId, setQueryId] = useState(schedule?.savedQueryId ?? '');
  const [frequency, setFrequency] = useState<Schedule['frequency']>(schedule?.frequency ?? 'daily');
  const [time, setTime] = useState(schedule?.time ?? '08:00');
  const [dayOfWeek, setDayOfWeek] = useState(asNumber(schedule?.dayOfWeek) ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(asNumber(schedule?.dayOfMonth) ?? 1);
  const [timezone, setTimezone] = useState(schedule?.timezone ?? workspace.data?.zonaHoraria ?? 'UTC');
  const [format, setFormat] = useState<ReportFormat>(schedule?.format ?? 'excel');
  const [recipients, setRecipients] = useState((schedule?.recipients ?? []).join(', '));
  const [sendEmail, setSendEmail] = useState(schedule?.sendEmail ?? true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const timeZones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [timezone];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const body = {
      savedQueryId: queryId,
      reportTitle: title.trim(),
      frequency,
      time,
      ...(frequency === 'weekly' ? { dayOfWeek } : {}),
      ...(frequency === 'monthly' ? { dayOfMonth } : {}),
      timezone,
      format,
      recipients: recipients.split(/[,;\s]+/).map((email) => email.trim()).filter(Boolean),
      sendEmail,
    };
    setIsSaving(true);
    try {
      const result = schedule
        ? await call((api) => api.PATCH('/reports/schedules/{id}', { params: { path: { id: schedule.id } }, body }))
        : await call((api) => api.POST('/reports/schedules', { body }));
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

  const noQueries = !queries.isLoading && (queries.data ?? []).length === 0;

  return (
    <Modal
      size="lg"
      title={schedule ? 'Editar tarea programada' : 'Nueva tarea programada'}
      description="Genera el reporte de una consulta guardada y lo envía por correo en la frecuencia que elijas."
      onClose={onClose}
      footer={
        <>
          <span className="connection-test">Cron: <code>{cronPreview(frequency, time, dayOfWeek, dayOfMonth)}</code> ({timezone})</span>
          <button className="button form-secondary" type="button" onClick={onClose}>Cancelar</button>
          <button className="button button--primary form-primary" type="submit" form="schedule-form" disabled={isSaving || noQueries}>{isSaving ? 'Guardando…' : schedule ? 'Guardar cambios' : 'Crear tarea'}</button>
        </>
      }
    >
      {noQueries ? (
        <p className="modal-text">Aún no hay consultas guardadas. Crea un cruce en el <Link className="auth-link" href="/queries">Editor de consultas</Link> y pulsa <strong>Guardar consulta</strong>; después podrás programarlo aquí.</p>
      ) : (
        <form id="schedule-form" method="post" className="form-grid" onSubmit={handleSubmit}>
          <label className="form-field form-field--wide"><span>Título del reporte</span><input className="form-input" required maxLength={150} placeholder="Ventas por cliente — semanal" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="form-field form-field--wide">
            <span>Consulta guardada</span>
            <select className="form-input" required value={queryId} onChange={(event) => setQueryId(event.target.value)}>
              <option value="">{queries.isLoading ? 'Cargando consultas…' : 'Elige una consulta'}</option>
              {(queries.data ?? []).map((query) => <option key={query.id} value={query.id}>{query.nombre}{query.visibilidad === 'PUBLICADA' ? ' · publicada' : ''}</option>)}
            </select>
          </label>
          <div className="form-field form-field--wide">
            <span>Frecuencia</span>
            <div className="segmented" role="radiogroup" aria-label="Frecuencia">
              {([['daily', 'Diaria'], ['weekly', 'Semanal'], ['monthly', 'Mensual']] as const).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={frequency === value} aria-pressed={frequency === value} onClick={() => setFrequency(value)}>{label}</button>
              ))}
            </div>
          </div>
          <label className="form-field"><span>Hora</span><input className="form-input" type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></label>
          {frequency === 'weekly' && (
            <label className="form-field"><span>Día de la semana</span><select className="form-input" value={dayOfWeek} onChange={(event) => setDayOfWeek(Number(event.target.value))}>{DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>
          )}
          {frequency === 'monthly' && (
            <label className="form-field"><span>Día del mes</span><input className="form-input" type="number" min={1} max={28} value={dayOfMonth} onChange={(event) => setDayOfMonth(Number(event.target.value))} /></label>
          )}
          <label className="form-field"><span>Zona horaria</span><select className="form-input" value={timezone} onChange={(event) => setTimezone(event.target.value)}>{[...new Set([timezone, ...timeZones])].map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <label className="form-field"><span>Formato</span><select className="form-input" value={format} onChange={(event) => setFormat(event.target.value as ReportFormat)}>{(Object.keys(FORMAT_LABELS) as ReportFormat[]).map((value) => <option key={value} value={value}>{FORMAT_LABELS[value]}</option>)}</select></label>
          <label className="form-check form-field--wide"><input type="checkbox" checked={sendEmail} onChange={(event) => setSendEmail(event.target.checked)} /><span>Enviar por correo al terminar</span></label>
          {sendEmail && (
            <label className="form-field form-field--wide"><span>Destinatarios (separados por comas; vacío = solo tú)</span><input className="form-input" placeholder="gerencia@empresa.com, ventas@empresa.com" value={recipients} onChange={(event) => setRecipients(event.target.value)} /></label>
          )}
          <p className="field-help form-field--wide"><Icon name="shield" size={12} /> El reporte respeta los permisos y el enmascaramiento de campos sensibles de quien creó la tarea.</p>
          {error && <p className="form-error form-field--wide" role="alert">{error}</p>}
        </form>
      )}
    </Modal>
  );
}
