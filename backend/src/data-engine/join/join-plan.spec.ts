import { describe, expect, it } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  createRowFlattener,
  describeJoinPlan,
  executeJoinPlan,
  normalizeJoinKey,
  validateJoinPlan,
  type JoinPlan,
  type JoinRelationSpec,
  type JoinSourceSpec,
  type JoinType,
} from './join-plan.js';

const source = (alias: string, entidad = alias): JoinSourceSpec => ({ alias, conexionId: `conn-${alias}`, entidad });
const relation = (izquierda: string, derecha: string, tipo: JoinType, llaves: Array<[string, string]>): JoinRelationSpec => ({
  izquierda,
  derecha,
  tipo,
  llaves: llaves.map(([l, r]) => ({ izquierda: l, derecha: r })),
});

const clientes = [
  { id: 1, nombre: 'Ana', email: 'ana@corp.com' },
  { id: 2, nombre: 'Luis', email: 'luis@corp.com' },
  { id: 3, nombre: 'Sin pedidos', email: 'sp@corp.com' },
];
const pedidos = [
  { pedido: 'P1', cliente_id: '1', total: 120 },
  { pedido: 'P2', cliente_id: 1, total: 80 },
  { pedido: 'P3', cliente_id: 2, total: 50 },
  { pedido: 'P4', cliente_id: 99, total: 10 },
];

/** Ejecuta un join de dos fuentes y devuelve las filas aplanadas. */
function joinTwo(tipo: JoinType) {
  const plan = validateJoinPlan([source('clientes'), source('pedidos')], [relation('clientes', 'pedidos', tipo, [['id', 'cliente_id']])]);
  const records = new Map<string, Record<string, unknown>[]>([
    ['clientes', clientes],
    ['pedidos', pedidos],
  ]);
  const flatten = createRowFlattener(plan, records);
  return executeJoinPlan(plan, records, 1_000).map(flatten);
}

describe('executeJoinPlan: tipos de join', () => {
  it('INNER: solo filas con pareja; 1 y "1" coinciden', () => {
    expect(joinTwo('INNER').map((row) => [row.nombre, row.pedido])).toEqual([
      ['Ana', 'P1'],
      ['Ana', 'P2'],
      ['Luis', 'P3'],
    ]);
  });

  it('LEFT: conserva los clientes sin pedidos con las columnas del pedido en null', () => {
    const rows = joinTwo('LEFT');
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual({ id: 3, nombre: 'Sin pedidos', email: 'sp@corp.com', pedido: null, cliente_id: null, total: null });
  });

  it('RIGHT: conserva los pedidos sin cliente con las columnas del cliente en null', () => {
    const rows = joinTwo('RIGHT');
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual({ id: null, nombre: null, email: null, pedido: 'P4', cliente_id: 99, total: 10 });
  });

  it('FULL: conserva ambos lados sin pareja', () => {
    const rows = joinTwo('FULL');
    expect(rows.map((row) => [row.nombre, row.pedido])).toEqual([
      ['Ana', 'P1'],
      ['Ana', 'P2'],
      ['Luis', 'P3'],
      ['Sin pedidos', null],
      [null, 'P4'],
    ]);
  });

  it('las llaves null nunca coinciden, ni entre sí (como NULL en SQL)', () => {
    const plan = validateJoinPlan([source('a'), source('b')], [relation('a', 'b', 'FULL', [['k', 'k']])]);
    const records = new Map<string, Record<string, unknown>[]>([
      ['a', [{ k: null, va: 1 }]],
      ['b', [{ k: null, vb: 2 }]],
    ]);
    expect(executeJoinPlan(plan, records, 10)).toHaveLength(2);
  });
});

describe('executeJoinPlan: tres fuentes y llaves compuestas', () => {
  const plan = validateJoinPlan(
    [source('clientes'), source('pedidos'), source('envios')],
    [
      relation('clientes', 'pedidos', 'INNER', [['id', 'cliente_id']]),
      relation('pedidos', 'envios', 'LEFT', [
        ['pedido', 'pedido_ref'],
        ['cliente_id', 'cliente'],
      ]),
    ],
  );
  const envios = [
    { pedido_ref: 'P1', cliente: 1, estado: 'entregado', email: 'logistica@corp.com' },
    { pedido_ref: 'P3', cliente: 999, estado: 'otro cliente' },
  ];
  const records = new Map<string, Record<string, unknown>[]>([
    ['clientes', clientes],
    ['pedidos', pedidos],
    ['envios', envios],
  ]);

  it('une tres fuentes en cadena con una llave compuesta', () => {
    const rows = executeJoinPlan(plan, records, 1_000).map(createRowFlattener(plan, records));
    expect(rows.map((row) => [row.nombre, row.pedido, row.estado])).toEqual([
      ['Ana', 'P1', 'entregado'],
      ['Ana', 'P2', null],
      // P3 tiene envío, pero de otro cliente: la llave compuesta no coincide.
      ['Luis', 'P3', null],
    ]);
  });

  it('califica con el alias las columnas que existen en varias fuentes', () => {
    const [first] = executeJoinPlan(plan, records, 1_000).map(createRowFlattener(plan, records));
    expect(first).toMatchObject({ 'clientes.email': 'ana@corp.com', 'envios.email': 'logistica@corp.com' });
    expect(first).not.toHaveProperty('email');
  });

  it('describe el plan para títulos y bitácora', () => {
    expect(describeJoinPlan({ ...plan, sources: [{ ...plan.sources[0], esquema: 'crm' }, ...plan.sources.slice(1)] })).toBe(
      'crm.clientes x pedidos x envios',
    );
  });

  it('acepta relaciones que parten de cualquier fuente ya unida (árbol, no solo cadena)', () => {
    const star = validateJoinPlan(
      [source('envios'), source('pedidos'), source('clientes')],
      [relation('clientes', 'pedidos', 'INNER', [['id', 'cliente_id']]), relation('clientes', 'envios', 'LEFT', [['id', 'cliente']])],
    );
    expect(star.sources.map((s) => s.alias)).toEqual(['clientes', 'pedidos', 'envios']);
  });
});

describe('executeJoinPlan: límites de memoria', () => {
  it('corta con 413 si un resultado intermedio supera el máximo de filas', () => {
    const plan = validateJoinPlan([source('a'), source('b')], [relation('a', 'b', 'INNER', [['k', 'k']])]);
    const many = Array.from({ length: 50 }, () => ({ k: 'x' }));
    const records = new Map<string, Record<string, unknown>[]>([
      ['a', many],
      ['b', many],
    ]);
    expect(() => executeJoinPlan(plan, records, 2_499)).toThrow(PayloadTooLargeException);
    expect(executeJoinPlan(plan, records, 2_500)).toHaveLength(2_500);
  });
});

describe('validateJoinPlan', () => {
  const ok = (): [JoinSourceSpec[], JoinRelationSpec[]] => [
    [source('a'), source('b'), source('c')],
    [relation('a', 'b', 'INNER', [['id', 'id']]), relation('b', 'c', 'LEFT', [['id', 'id']])],
  ];

  it.each<[string, (plan: [JoinSourceSpec[], JoinRelationSpec[]]) => void]>([
    ['una sola fuente', ([s, r]) => (s.splice(1), r.splice(0))],
    ['más de cinco fuentes', ([s]) => s.push(source('d'), source('e'), source('f'))],
    ['alias repetido', ([s]) => (s[2] = source('a'))],
    ['alias inválido', ([s]) => (s[0] = source('1abc'))],
    ['falta una relación', ([, r]) => r.pop()],
    ['tipo de join desconocido', ([, r]) => (r[0] = { ...r[0], tipo: 'CROSS' as JoinType })],
    ['alias que no existe', ([, r]) => (r[1] = { ...r[1], derecha: 'z' })],
    ['ciclo: une una fuente ya unida', ([, r]) => (r[1] = { ...r[1], derecha: 'a' })],
    ['parte de una fuente aún no unida', ([, r]) => (r[1] = { ...r[1], izquierda: 'c', derecha: 'b' })],
    ['une una fuente consigo misma', ([, r]) => (r[0] = { ...r[0], derecha: 'a' })],
    ['sin llaves', ([, r]) => (r[0] = { ...r[0], llaves: [] })],
    ['más de tres llaves', ([, r]) => (r[0] = { ...r[0], llaves: Array(4).fill({ izquierda: 'x', derecha: 'y' }) })],
    ['llave vacía', ([, r]) => (r[0] = { ...r[0], llaves: [{ izquierda: ' ', derecha: 'id' }] })],
  ])('rechaza: %s', (_reason, mutate) => {
    const plan = ok();
    mutate(plan);
    expect(() => validateJoinPlan(...plan)).toThrow(BadRequestException);
  });

  it('acepta un plan válido y ordena las fuentes según las relaciones', () => {
    const [sources, relations] = ok();
    const plan: JoinPlan = validateJoinPlan([sources[2], sources[0], sources[1]], relations);
    expect(plan.sources.map((s) => s.alias)).toEqual(['a', 'b', 'c']);
  });
});

describe('normalizeJoinKey', () => {
  it.each([
    ['  C1 ', 'C1'],
    [1, '1'],
    [1.5, '1.5'],
    [10n, '10'],
    [true, 'true'],
    [new Date('2026-11-06T00:00:00Z'), '2026-11-06T00:00:00.000Z'],
  ])('caso %# → %s', (value, expected) => expect(normalizeJoinKey(value)).toBe(expected));

  it.each([null, undefined, Number.NaN, { a: 1 }, [1], new Date('x')])('caso %# no cruza', (value) => {
    expect(normalizeJoinKey(value)).toBeNull();
  });
});
