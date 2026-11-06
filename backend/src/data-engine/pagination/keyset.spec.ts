import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import {
  buildKeysetCondition,
  cursorBinding,
  decodeCursor,
  encodeCursor,
  toCursorValue,
  toDataPage,
  toSqlParameter,
} from './keyset.js';

describe('buildKeysetCondition', () => {
  const placeholders = () => {
    const values: unknown[] = [];
    return { values, parameter: (value: unknown) => (values.push(value), `$${values.length}`) };
  };

  it('una sola columna: col > valor', () => {
    const { values, parameter } = placeholders();
    expect(buildKeysetCondition(['"id"'], [41], parameter)).toBe('("id" > $1)');
    expect(values).toEqual([41]);
  });

  it('llave compuesta: equivalente a (a, b, c) > (x, y, z) sin row values', () => {
    const { values, parameter } = placeholders();
    expect(buildKeysetCondition(['a', 'b', 'c'], ['x', 2, true], parameter)).toBe(
      '((a > $1) OR (a = $2 AND b > $3) OR (a = $4 AND b = $5 AND c > $6))',
    );
    expect(values).toEqual(['x', 'x', 2, 'x', 2, true]);
  });

  it('las fechas viajan como Date y un cursor de otra forma se rechaza', () => {
    const { values, parameter } = placeholders();
    buildKeysetCondition(['alta'], [{ $date: '2026-11-06T00:00:00.000Z' }], parameter);
    expect(values[0]).toEqual(new Date('2026-11-06T00:00:00.000Z'));
    expect(() => buildKeysetCondition(['a', 'b'], [1], parameter)).toThrow(BadRequestException);
    expect(() => toSqlParameter({ $oid: '65a1b2c3d4e5f6a7b8c9d0e1' })).toThrow(BadRequestException);
  });
});

describe('Cursor opaco', () => {
  const binding = cursorBinding('conn-1', 'clientes', 'public');

  it('ida y vuelta con todos los tipos de llave', () => {
    const key = [7, 'C-1', true, { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, { $date: '2026-11-06T00:00:00.000Z' }];
    const cursor = encodeCursor(binding, key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, binding)).toEqual(key);
  });

  it('no sirve para otra tabla, esquema o conexión', () => {
    const cursor = encodeCursor(binding, [1]);
    for (const other of [
      cursorBinding('conn-1', 'pedidos', 'public'),
      cursorBinding('conn-1', 'clientes', 'ventas'),
      cursorBinding('conn-2', 'clientes', 'public'),
    ]) {
      expect(() => decodeCursor(cursor, other)).toThrow(BadRequestException);
    }
  });

  it.each([
    ['basura', 'no-es-un-cursor!'],
    ['JSON que no es cursor', Buffer.from('{"hola":1}').toString('base64url')],
    ['versión desconocida', Buffer.from(JSON.stringify({ v: 9, b: 'x', k: [1] })).toString('base64url')],
    ['operador inyectado', null],
    ['demasiado largo', 'a'.repeat(3000)],
  ])('rechaza un cursor manipulado: %s', (_label, cursor) => {
    const tampered =
      cursor ?? Buffer.from(JSON.stringify({ v: 1, b: binding, k: [{ $gt: '' }] })).toString('base64url');
    expect(() => decodeCursor(tampered, binding)).toThrow(BadRequestException);
  });
});

describe('toCursorValue', () => {
  it('convierte los tipos de llave de cada driver', () => {
    expect(toCursorValue(5)).toBe(5);
    expect(toCursorValue('a')).toBe('a');
    expect(toCursorValue(10n)).toBe('10');
    expect(toCursorValue(new Date('2026-01-01T00:00:00Z'))).toEqual({ $date: '2026-01-01T00:00:00.000Z' });
    const id = new ObjectId();
    expect(toCursorValue(id)).toEqual({ $oid: id.toHexString() });
  });

  it('rechaza llaves que no se pueden comparar', () => {
    expect(() => toCursorValue(null)).toThrow(BadRequestException);
    expect(() => toCursorValue({ a: 1 })).toThrow(BadRequestException);
  });
});

describe('toDataPage', () => {
  afterEach(() => vi.unstubAllEnvs());
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, alta: new Date(Date.UTC(2026, 0, i + 1)) }));

  it('con una fila de más hay página siguiente y la llave es la de la última fila mostrada', () => {
    const page = toDataPage(rows, ['id', 'alta'], 3, (row) => ({ ...row }));
    expect(page.rows).toHaveLength(3);
    expect(page.lastKey).toEqual([3, { $date: '2026-01-03T00:00:00.000Z' }]);
    expect(page.orderBy).toEqual(['id', 'alta']);
  });

  it('sin fila de más es la última página', () => {
    expect(toDataPage(rows, ['id'], 4, (row) => row).lastKey).toBeNull();
    expect(toDataPage([], ['id'], 4, (row) => row)).toEqual({ rows: [], orderBy: ['id'], lastKey: null });
  });

  it('corta con 413 si la página supera el máximo de bytes', () => {
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_BYTES', '20');
    expect(() => toDataPage(rows, ['id'], 3, (row) => row)).toThrow(PayloadTooLargeException);
  });
});
