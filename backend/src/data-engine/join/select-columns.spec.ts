import { describe, expect, it } from 'vitest';
import { selectColumns } from './select-columns.js';

describe('selectColumns (columnas de salida del editor de consultas)', () => {
  const rows = [
    { id: 1, nombre: 'Ana', email: '***@gmail.com', total: 120 },
    { id: 2, nombre: 'Luis', total: 80 },
  ];

  it('deja solo las columnas elegidas y en el orden elegido', () => {
    const result = selectColumns(rows, ['total', 'nombre']);
    expect(result).toEqual([{ total: 120, nombre: 'Ana' }, { total: 80, nombre: 'Luis' }]);
    expect(Object.keys(result[0])).toEqual(['total', 'nombre']);
  });

  it('una columna que falta en una fila sale en null', () => {
    expect(selectColumns(rows, ['nombre', 'email'])[1]).toEqual({ nombre: 'Luis', email: null });
  });

  it('sin lista devuelve las filas tal cual', () => {
    expect(selectColumns(rows)).toBe(rows);
    expect(selectColumns(rows, [])).toBe(rows);
  });
});
