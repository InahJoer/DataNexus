import { describe, expect, it } from 'vitest';
import { isValidTimeZone, lastUtcDays, monthRanges, percentChange, zonedMidnight } from './dashboard-time.js';

describe('Fechas del dashboard por zona horaria', () => {
  it('calcula el mes local en curso y el anterior (America/Managua, UTC-6)', () => {
    // 5 nov 2026 22:00 en Managua = 6 nov 04:00 UTC: sigue siendo noviembre en ambas.
    const { current, previous } = monthRanges(new Date('2026-11-06T04:00:00Z'), 'America/Managua');
    expect(current).toEqual({
      key: '2026-11',
      start: new Date('2026-11-01T06:00:00Z'),
      end: new Date('2026-12-01T06:00:00Z'),
    });
    expect(previous.key).toBe('2026-10');
    expect(previous.start).toEqual(new Date('2026-10-01T06:00:00Z'));
  });

  it('usa el mes local aunque en UTC ya haya cambiado', () => {
    // 31 oct 2026 21:00 en Managua = 1 nov 03:00 UTC.
    expect(monthRanges(new Date('2026-11-01T03:00:00Z'), 'America/Managua').current.key).toBe('2026-10');
  });

  it('respeta el horario de verano (Europe/Madrid cambia a UTC+1 el 25 oct 2026)', () => {
    expect(zonedMidnight(2026, 10, 1, 'Europe/Madrid')).toEqual(new Date('2026-09-30T22:00:00Z'));
    expect(zonedMidnight(2026, 11, 1, 'Europe/Madrid')).toEqual(new Date('2026-10-31T23:00:00Z'));
  });

  it('cruza de año en enero', () => {
    const { current, previous } = monthRanges(new Date('2026-01-15T12:00:00Z'), 'UTC');
    expect(previous.key).toBe('2025-12');
    expect(current.end).toEqual(new Date('2026-02-01T00:00:00Z'));
  });

  it('lista los últimos días UTC en orden', () => {
    expect(lastUtcDays(new Date('2026-11-02T10:00:00Z'), 4)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('calcula la variación con un decimal y null sin base', () => {
    expect(percentChange(1284, 1083)).toBe(18.6);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(10, 0)).toBeNull();
  });

  it('valida zonas horarias', () => {
    expect(isValidTimeZone('America/Managua')).toBe(true);
    expect(isValidTimeZone('Marte/Olympus')).toBe(false);
  });
});
