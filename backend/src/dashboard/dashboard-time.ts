/** Utilidades de fechas por zona horaria IANA para las métricas del dashboard (issue #40). */

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

/** Instante UTC de la medianoche local de una fecha en `timeZone` (tiene en cuenta el horario de verano). */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  // Dos pasadas bastan para converger incluso cerca de un cambio de horario.
  for (let i = 0; i < 2; i += 1) {
    const local = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    guess += target - asUtc;
  }
  return new Date(guess);
}

export interface MonthRange {
  /** YYYY-MM del mes local. */
  key: string;
  start: Date;
  end: Date;
}

/** Mes local en curso y el anterior, como intervalos [start, end) en UTC. */
export function monthRanges(now: Date, timeZone: string): { current: MonthRange; previous: MonthRange } {
  const local = localParts(now, timeZone);
  const range = (year: number, month: number): MonthRange => {
    const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    return {
      key: `${year}-${String(month).padStart(2, '0')}`,
      start: zonedMidnight(year, month, 1, timeZone),
      end: zonedMidnight(next.year, next.month, 1, timeZone),
    };
  };
  const previous = local.month === 1 ? { year: local.year - 1, month: 12 } : { year: local.year, month: local.month - 1 };
  return { current: range(local.year, local.month), previous: range(previous.year, previous.month) };
}

/** Días UTC (YYYY-MM-DD) desde hace `count - 1` días hasta hoy, en orden cronológico. */
export function lastUtcDays(now: Date, count: number): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, index) =>
    new Date(today - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Variación porcentual con un decimal; null si no hay base de comparación. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}
