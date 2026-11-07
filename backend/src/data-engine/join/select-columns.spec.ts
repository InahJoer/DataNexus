import { describe, expect, it } from 'vitest';
import { selectColumns, sortRows } from './select-columns.js';

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

describe('alias y orden del resultado (Query Builder)', () => {
  const rows = [
    { nombre: 'Luis', total: 80, ciudad: 'León' },
    { nombre: 'Ana', total: 120, ciudad: 'Managua' },
    { nombre: 'Eva', total: null, ciudad: 'León' },
    { nombre: 'Jon', total: 120, ciudad: 'Granada' },
  ];

  it('renombra columnas con o sin lista de columnas', () => {
    expect(selectColumns(rows, ['nombre'], { nombre: 'Cliente' })[0]).toEqual({ Cliente: 'Luis' });
    expect(Object.keys(selectColumns(rows, undefined, { total: 'Monto' })[0])).toEqual(['nombre', 'Monto', 'ciudad']);
  });

  it('ordena por varias columnas, de forma estable y con los vacíos al final', () => {
    expect(sortRows(rows, [{ campo: 'total', direccion: 'DESC' }, { campo: 'ciudad', direccion: 'ASC' }]).map((row) => row.nombre)).toEqual(['Jon', 'Ana', 'Luis', 'Eva']);
    expect(sortRows(rows, [{ campo: 'total', direccion: 'ASC' }]).map((row) => row.nombre)).toEqual(['Luis', 'Ana', 'Jon', 'Eva']);
    expect(sortRows(rows)).toBe(rows);
  });
});
