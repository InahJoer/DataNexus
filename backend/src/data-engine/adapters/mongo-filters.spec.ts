import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Binary, Decimal128, Long, ObjectId, Timestamp, UUID } from 'mongodb';
import { assertMongoCollectionName, buildMongoFilter } from './mongo-filters.js';
import { normalizeBsonValue } from './mongodb.adapter.js';

describe('buildMongoFilter (filter pushdown a MongoDB)', () => {
  it('sin filtros devuelve un filtro vacío', () => {
    expect(buildMongoFilter()).toEqual({});
    expect(buildMongoFilter([])).toEqual({});
  });

  it('traduce cada operador a su equivalente de MongoDB', () => {
    expect(buildMongoFilter([{ campo: 'estado', operador: 'eq', valor: 'pagado' }])).toEqual({ estado: { $eq: 'pagado' } });
    expect(
      buildMongoFilter([
        { campo: 'total', operador: 'gte', valor: 10 },
        { campo: 'total', operador: 'lt', valor: 100 },
        { campo: 'canal', operador: 'neq', valor: 'web' },
        { campo: 'pais', operador: 'in', valor: ['NI', 'CR'] },
        { campo: 'tipo', operador: 'not-in', valor: ['prueba'] },
        { campo: 'activo', operador: 'gt', valor: false },
        { campo: 'stock', operador: 'lte', valor: 0 },
      ]),
    ).toEqual({
      $and: [
        { total: { $gte: 10 } },
        { total: { $lt: 100 } },
        // Como en SQL, neq y not-in no incluyen documentos con el campo en null o sin el campo.
        { canal: { $nin: ['web', null] } },
        { pais: { $in: ['NI', 'CR'] } },
        { tipo: { $nin: ['prueba', null] } },
        { activo: { $gt: false } },
        { stock: { $lte: 0 } },
      ],
    });
  });

  it('eq/neq null equivalen a IS NULL / IS NOT NULL', () => {
    expect(buildMongoFilter([{ campo: 'baja', operador: 'eq', valor: null }])).toEqual({ baja: { $eq: null } });
    expect(buildMongoFilter([{ campo: 'baja', operador: 'neq', valor: null }])).toEqual({ baja: { $ne: null } });
  });

  it('admite rutas de campos anidados con punto', () => {
    expect(buildMongoFilter([{ campo: 'cliente.id', operador: 'eq', valor: 'C1' }])).toEqual({ 'cliente.id': { $eq: 'C1' } });
  });

  it.each([
    ['$where', 'operador como campo'],
    ['cliente.$id', 'segmento con $'],
    ['a..b', 'segmento vacío'],
    ['', 'vacío'],
    ['x'.repeat(151), 'demasiado largo'],
    ['campo\0', 'con NUL'],
  ])('rechaza el campo %j (%s)', (campo) => {
    expect(() => buildMongoFilter([{ campo, operador: 'eq', valor: 1 }])).toThrow(BadRequestException);
  });

  it.each([
    [{ $gt: '' }, 'objeto con operador (inyección NoSQL)'],
    [{ $where: 'sleep(1000)' }, '$where'],
    [[1, 2], 'lista en un operador escalar'],
    [Number.NaN, 'NaN'],
    [undefined, 'sin valor'],
  ] as Array<[unknown, string]>)('rechaza el valor %j (%s)', (valor) => {
    expect(() => buildMongoFilter([{ campo: 'total', operador: 'eq', valor } as never])).toThrow(BadRequestException);
  });

  it('valida las listas de in / not-in', () => {
    expect(() => buildMongoFilter([{ campo: 'a', operador: 'in', valor: [] }])).toThrow(BadRequestException);
    expect(() => buildMongoFilter([{ campo: 'a', operador: 'in', valor: Array.from({ length: 11 }, (_, i) => i) }])).toThrow(
      BadRequestException,
    );
    expect(() => buildMongoFilter([{ campo: 'a', operador: 'in', valor: [null] } as never])).toThrow(BadRequestException);
    expect(() => buildMongoFilter([{ campo: 'a', operador: 'in', valor: [{ $ne: 1 }] } as never])).toThrow(
      BadRequestException,
    );
  });

  it('rechaza null en operadores de comparación y operadores desconocidos', () => {
    expect(() => buildMongoFilter([{ campo: 'a', operador: 'gt', valor: null }])).toThrow(BadRequestException);
    expect(() => buildMongoFilter([{ campo: 'a', operador: 'regex', valor: '.*' } as never])).toThrow(BadRequestException);
  });
});

describe('assertMongoCollectionName', () => {
  it.each(['pedidos', 'eventos_app', 'ventas.2026'])('acepta %s', (name) => {
    expect(() => assertMongoCollectionName(name)).not.toThrow();
  });

  it.each(['', '$cmd', 'system.users', 'a\0b', 'x'.repeat(121)])('rechaza %j', (name) => {
    expect(() => assertMongoCollectionName(name)).toThrow(BadRequestException);
  });
});

describe('normalizeBsonValue', () => {
  it('convierte tipos BSON en valores JSON estables', () => {
    const id = new ObjectId('65a1b2c3d4e5f6a7b8c9d0e1');
    const uuid = new UUID('3f2a3c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b');
    const value = normalizeBsonValue({
      _id: id,
      fecha: new Date('2026-11-06T10:00:00.000Z'),
      precio: Decimal128.fromString('19.99'),
      enorme: Decimal128.fromString('12345678901234567890.123456789'),
      contador: Long.fromNumber(42),
      grande: Long.fromString('9223372036854775807'),
      foto: new Binary(Buffer.from('hola')),
      uuid: new Binary(uuid.buffer, 4),
      ts: new Timestamp({ t: 1_700_000_000, i: 3 }),
      anidado: { ref: id, lista: [id, 1, 'x', null] },
    });
    expect(value).toEqual({
      _id: '65a1b2c3d4e5f6a7b8c9d0e1',
      fecha: '2026-11-06T10:00:00.000Z',
      precio: 19.99,
      enorme: '12345678901234567890.123456789',
      contador: 42,
      grande: '9223372036854775807',
      foto: Buffer.from('hola').toString('base64'),
      uuid: '3f2a3c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
      ts: { t: 1_700_000_000, i: 3 },
      anidado: { ref: '65a1b2c3d4e5f6a7b8c9d0e1', lista: ['65a1b2c3d4e5f6a7b8c9d0e1', 1, 'x', null] },
    });
  });

  it('deja intactos los escalares', () => {
    for (const scalar of ['a', 1, true, null]) expect(normalizeBsonValue(scalar)).toBe(scalar);
    expect(normalizeBsonValue(undefined)).toBeUndefined();
  });
});
