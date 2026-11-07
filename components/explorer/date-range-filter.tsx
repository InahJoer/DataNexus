'use client';

import { useId, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icons';

export type DateFilter = { campo: string; operador: 'between' | 'gte' | 'lte'; valor: string | [string, string] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Columnas cuyos valores parecen fechas (ISO), para sugerirlas primero. */
export function dateColumns(rows: Record<string, unknown>[], columns: string[]): string[] {
  return columns.filter((column) => {
    const values = rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined);
    return values.length > 0 && values.every((value) => typeof value === 'string' && ISO_DATE.test(value));
  });
}

/** El rango cubre días completos en UTC (00:00:00.000 a 23:59:59.999), igual en todos los motores. */
const startOfDay = (day: string) => `${day}T00:00:00.000Z`;
const endOfDay = (day: string) => `${day}T23:59:59.999Z`;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

function preset(kind: 'today' | '7d' | '30d' | 'month' | 'lastMonth' | 'year'): [string, string] {
  const now = new Date();
  const today = isoDay(now);
  const daysAgo = (days: number) => isoDay(new Date(now.getTime() - days * 86_400_000));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (kind) {
    case 'today': return [today, today];
    case '7d': return [daysAgo(6), today];
    case '30d': return [daysAgo(29), today];
    case 'month': return [isoDay(new Date(Date.UTC(y, m, 1))), today];
    case 'lastMonth': return [isoDay(new Date(Date.UTC(y, m - 1, 1))), isoDay(new Date(Date.UTC(y, m, 0)))];
    case 'year': return [`${y}-01-01`, today];
  }
}

const PRESETS = [
  { kind: 'today', label: 'Hoy' },
  { kind: '7d', label: 'Últimos 7 días' },
  { kind: '30d', label: 'Últimos 30 días' },
  { kind: 'month', label: 'Este mes' },
  { kind: 'lastMonth', label: 'Mes pasado' },
  { kind: 'year', label: 'Este año' },
] as const;

/** Texto del chip: "creado: 01/01/2026 → 31/01/2026". */
export function describeDateFilter(filter: { operador: string; valor: unknown }): string | null {
  const format = (iso: string) => new Intl.DateTimeFormat('es', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
  if (filter.operador === 'between' && Array.isArray(filter.valor) && filter.valor.every((value) => typeof value === 'string' && ISO_DATE.test(value))) {
    return `${format(filter.valor[0])} → ${format(filter.valor[1])}`;
  }
  if ((filter.operador === 'gte' || filter.operador === 'lte') && typeof filter.valor === 'string' && ISO_DATE.test(filter.valor)) {
    return `${filter.operador === 'gte' ? 'desde' : 'hasta'} ${format(filter.valor)}`;
  }
  return null;
}

type DateRangeFilterProps = Readonly<{
  /** Columnas con fechas detectadas en la página; el campo también se puede escribir (por ejemplo, envio.fecha). */
  suggested: string[];
  onApply: (filter: DateFilter) => void;
}>;

/** Filtro "de tal fecha a tal fecha" del explorador, con atajos (hoy, últimos 7 días, este mes…). */
export function DateRangeFilter({ suggested, onApply }: DateRangeFilterProps) {
  const [field, setField] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const campo = field || suggested[0] || '';
  const listId = useId();

  function apply(range: [string, string] | null, event?: FormEvent) {
    event?.preventDefault();
    const [start, end] = range ?? [from, to];
    if (!campo) return setError('Elige el campo de fecha');
    if (!start && !end) return setError('Elige al menos una fecha');
    if (start && end && start > end) return setError('La fecha inicial no puede ser posterior a la final');
    setError(null);
    if (range) {
      setFrom(start);
      setTo(end);
    }
    if (start && end) onApply({ campo, operador: 'between', valor: [startOfDay(start), endOfDay(end)] });
    else if (start) onApply({ campo, operador: 'gte', valor: startOfDay(start) });
    else onApply({ campo, operador: 'lte', valor: endOfDay(end) });
  }

  return (
    <form className="date-filter" onSubmit={(event) => apply(null, event)} aria-label="Filtrar por rango de fechas">
      <Icon name="calendar" size={14} />
      <input
        className="form-input"
        list={listId}
        placeholder={suggested[0] ? `Campo de fecha (${suggested[0]})` : 'Campo de fecha'}
        value={field}
        onChange={(event) => setField(event.target.value)}
        aria-label="Campo de fecha"
      />
      <datalist id={listId}>{suggested.map((column) => <option key={column} value={column} />)}</datalist>
      <label><span>Desde</span><input className="form-input" type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
      <label><span>Hasta</span><input className="form-input" type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
      <button className="button form-secondary" type="submit" disabled={!campo}>Aplicar</button>
      <div className="date-presets" role="group" aria-label="Rangos rápidos">
        {PRESETS.map((item) => (
          <button key={item.kind} type="button" className="row-action" disabled={!campo} onClick={() => apply(preset(item.kind))}>{item.label}</button>
        ))}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}
