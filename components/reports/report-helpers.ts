import type { components } from '@/lib/api/schema';

export type Schedule = components['schemas']['ScheduledReportResponseDto'];
export type Execution = components['schemas']['ReportExecutionResponseDto'];
export type ReportFormat = Schedule['format'];

// OpenAPI tipa algunos campos opcionales como objetos sin forma: se leen con cuidado.
export const asText = (value: unknown) => (typeof value === 'string' ? value : null);
export const asNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export const FORMAT_LABELS: Record<ReportFormat, string> = { excel: 'Excel', pdf: 'PDF', json: 'JSON', word: 'Word' };
export const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function dateTime(value: unknown) {
  const text = asText(value);
  if (!text) return '—';
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(text));
}

export function relative(value: unknown) {
  const text = asText(value);
  if (!text) return null;
  const minutes = Math.round((new Date(text).getTime() - Date.now()) / 60_000);
  const abs = Math.abs(minutes);
  const label = abs < 60 ? `${abs} min` : abs < 60 * 24 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return minutes >= 0 ? `en ${label}` : `hace ${label}`;
}

/** "Diaria a las 08:00", "Semanal, lunes 08:00", "Mensual, día 1 a las 08:00". */
export function describeFrequency(schedule: Pick<Schedule, 'frequency' | 'time' | 'dayOfWeek' | 'dayOfMonth'>) {
  const day = asNumber(schedule.dayOfWeek);
  const dayOfMonth = asNumber(schedule.dayOfMonth);
  if (schedule.frequency === 'weekly') return `Semanal, ${DAYS[day ?? 1]} ${schedule.time}`;
  if (schedule.frequency === 'monthly') return `Mensual, día ${dayOfMonth ?? 1} a las ${schedule.time}`;
  return `Diaria a las ${schedule.time}`;
}

/** Expresión cron equivalente (la API calcula la definitiva; esta es la vista previa del formulario). */
export function cronPreview(frequency: Schedule['frequency'], time: string, dayOfWeek: number, dayOfMonth: number) {
  const [hour = '0', minute = '0'] = time.split(':');
  const m = Number(minute);
  const h = Number(hour);
  if (frequency === 'weekly') return `${m} ${h} * * ${dayOfWeek}`;
  if (frequency === 'monthly') return `${m} ${h} ${dayOfMonth} * *`;
  return `${m} ${h} * * *`;
}

export function formatDuration(ms: unknown) {
  const value = asNumber(ms);
  if (value === null) return '—';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toLocaleString('es', { maximumFractionDigits: 1 })} s`;
  return `${Math.round(value / 60_000)} min`;
}

export function formatSize(bytes: unknown) {
  const value = asNumber(bytes);
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toLocaleString('es', { maximumFractionDigits: 1 })} KB`;
  return `${(value / 1024 ** 2).toLocaleString('es', { maximumFractionDigits: 1 })} MB`;
}

export const STATUS_VIEW: Record<Schedule['status'], { label: string; tone: string }> = {
  ACTIVE: { label: 'Activa', tone: 'ok' },
  PAUSED: { label: 'Pausada', tone: 'muted' },
  ERROR: { label: 'Con error', tone: 'error' },
};

export const EXECUTION_STATUS: Record<Execution['status'], { label: string; tone: string }> = {
  RUNNING: { label: 'En curso', tone: 'muted' },
  SUCCEEDED: { label: 'Completada', tone: 'ok' },
  FAILED: { label: 'Fallida', tone: 'error' },
};

export const TRIGGER_LABELS: Record<Execution['trigger'], string> = { SCHEDULED: 'Programada', MANUAL: 'Ejecutar ahora', ON_DEMAND: 'A pedido' };
