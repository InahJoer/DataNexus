import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  assertValidFilters,
  countConditions,
  describeFilterError,
  escapeLikePattern,
  escapeRegExp,
  isDateRangeFilter,
  matchesFilters,
  parseIsoDate,
  splitFiltersForPushdown,
  type FilterNode,
} from './filter-tree.js';

const rows = [
  { id: 1, nombre: 'Ana López', email: 'ana@corp.com', alta: '2026-01-10', total: 120, pais: 'NI', baja: null },
  { id: 2, nombre: 'Luis Ruiz', email: 'luis@otra.com', alta: '2026-03-02', total: '50', pais: 'CR' },
  { id: 3, nombre: 'ana maría', email: null, alta: '2025-12-31', total: 300, pais: 'NI', cliente: { tipo: 'vip' } },
  { id: 4, nombre: '100%_real', email: 'x@corp.com', alta: '2026-02-01', total: null, pais: 'HN' },
];
const ids = (filters: FilterNode[]) => rows.filter((row) => matchesFilters(row, filters)).map((row) => row.id);

describe('matchesFilters: operadores nuevos (RF-15)', () => {
  it('between incluye ambos extremos, con números y con fechas ISO', () => {
    expect(ids([{ campo: 'total', operador: 'between', valor: [50, 120] }])).toEqual([1, 2]);
    expect(ids([{ campo: 'alta', operador: 'between', valor: ['2026-01-01', '2026-02-28'] }])).toEqual([1, 4]);
  });

  it('contains y startsWith no distinguen mayúsculas', () => {
    expect(ids([{ campo: 'nombre', operador: 'contains', valor: 'ANA' }])).toEqual([1, 3]);
    expect(ids([{ campo: 'nombre', operador: 'startsWith', valor: 'ana' }])).toEqual([1, 3]);
    expect(ids([{ campo: 'email', operador: 'contains', valor: '@corp.com' }])).toEqual([1, 4]);
  });

  it('contains busca % y _ literalmente', () => {
    expect(ids([{ campo: 'nombre', operador: 'contains', valor: '%_' }])).toEqual([4]);
  });

  it('isNull distingue nulos y campos ausentes de valores presentes', () => {
    expect(ids([{ campo: 'email', operador: 'isNull', valor: true }])).toEqual([3]);
    expect(ids([{ campo: 'baja', operador: 'isNull', valor: true }])).toEqual([1, 2, 3, 4]);
    expect(ids([{ campo: 'total', operador: 'isNull', valor: false }])).toEqual([1, 2, 3]);
  });

  it('compara números aunque lleguen como texto y neq / not-in excluyen nulos como en SQL', () => {
    expect(ids([{ campo: 'total', operador: 'gte', valor: 50 }])).toEqual([1, 2, 3]);
    expect(ids([{ campo: 'total', operador: 'neq', valor: 120 }])).toEqual([2, 3]);
    expect(ids([{ campo: 'email', operador: 'not-in', valor: ['ana@corp.com'] }])).toEqual([2, 4]);
  });

  it('lee campos anidados de documentos con punto', () => {
    expect(ids([{ campo: 'cliente.tipo', operador: 'eq', valor: 'vip' }])).toEqual([3]);
  });
});

describe('matchesFilters: grupos AND / OR anidados', () => {
  it('combina la lista con AND y los grupos según su lógica', () => {
    expect(
      ids([
        { campo: 'pais', operador: 'eq', valor: 'NI' },
        {
          logica: 'OR',
          filtros: [
            { campo: 'total', operador: 'gt', valor: 200 },
            { campo: 'email', operador: 'contains', valor: 'ana' },
          ],
        },
      ]),
    ).toEqual([1, 3]);
  });

  it('admite grupos dentro de grupos', () => {
    expect(
      ids([
        {
          logica: 'OR',
          filtros: [
            { campo: 'pais', operador: 'eq', valor: 'HN' },
            {
              logica: 'AND',
              filtros: [
                { campo: 'pais', operador: 'eq', valor: 'CR' },
                { campo: 'total', operador: 'lt', valor: 100 },
              ],
            },
          ],
        },
      ]),
    ).toEqual([2, 4]);
  });
});

describe('describeFilterError / assertValidFilters', () => {
  const leaf = { campo: 'a', operador: 'eq', valor: 1 } as const;
  const nest = (depth: number): FilterNode => (depth === 0 ? leaf : { logica: 'AND', filtros: [nest(depth - 1)] });

  it.each([
    [[{ campo: 'a', operador: 'between', valor: [1] }], 'between necesita [mínimo, máximo]'],
    [[{ campo: 'a', operador: 'between', valor: [10, 1] }], 'el mínimo no puede ser mayor'],
    [[{ campo: 'a', operador: 'between', valor: [1, '9'] }], 'dos números o dos textos'],
    [[{ campo: 'a', operador: 'contains', valor: '' }], 'contains necesita un texto'],
    [[{ campo: 'a', operador: 'contains', valor: 'x'.repeat(201) }], 'contains necesita un texto'],
    [[{ campo: 'a', operador: 'startsWith', valor: 5 }], 'startsWith necesita un texto'],
    [[{ campo: 'a', operador: 'isNull', valor: 'si' }], 'isNull necesita true'],
    [[{ campo: 'a', operador: 'gt', valor: null }], 'gt necesita un valor escalar'],
    [[{ campo: 'a', operador: 'eq', valor: { $gt: '' } }], 'eq necesita un valor escalar o null'],
    [[{ campo: 'a', operador: 'in', valor: [null] }], 'in necesita una lista'],
    [[{ campo: 'a', operador: 'regex', valor: '.*' }], 'operador debe ser uno de'],
    [[{ campo: '', operador: 'eq', valor: 1 }], 'campo debe ser'],
    [[{ logica: 'XOR', filtros: [leaf] }], 'logica debe ser AND u OR'],
    [[{ logica: 'OR', filtros: [] }], 'al menos un filtro'],
    [[nest(4)], 'como máximo 3 niveles'],
    [Array(21).fill(leaf), 'como máximo 20 condiciones'],
    [[{ logica: 'OR', filtros: Array(21).fill(leaf) }], 'como máximo 20 condiciones'],
    ['no-lista', 'deben ser una lista'],
  ])('rechaza %j', (filters, message) => {
    expect(describeFilterError(filters)).toContain(message);
    expect(() => assertValidFilters(filters)).toThrow(BadRequestException);
  });

  it('acepta filtros válidos, tres niveles de grupos y ausencia de filtros', () => {
    expect(describeFilterError(undefined)).toBeNull();
    expect(describeFilterError([nest(3)])).toBeNull();
    expect(
      describeFilterError([
        { campo: 'a', operador: 'between', valor: ['2026-01-01', '2026-12-31'] },
        { campo: 'b', operador: 'isNull', valor: false },
        { campo: 'c', operador: 'startsWith', valor: 'AB' },
        { campo: 'd', operador: 'eq', valor: null },
      ]),
    ).toBeNull();
  });

  it('cuenta las condiciones dentro de los grupos', () => {
    expect(countConditions([leaf, { logica: 'OR', filtros: [leaf, nest(2)] }])).toBe(3);
    expect(countConditions(undefined)).toBe(0);
  });
});

describe('splitFiltersForPushdown', () => {
  const contains = { campo: 'nombre', operador: 'contains', valor: 'ana' } as const;
  const eq = { campo: 'pais', operador: 'eq', valor: 'NI' } as const;
  const orGroup: FilterNode = { logica: 'OR', filtros: [eq, { campo: 'total', operador: 'gt', valor: 1 }] };
  const noText = (filter: { operador: string }) => filter.operador !== 'contains';

  it('envía al motor lo que puede y deja el resto para memoria, por filtro de primer nivel', () => {
    expect(splitFiltersForPushdown([eq, contains, orGroup], noText)).toEqual({ pushed: [eq, orGroup], residual: [contains] });
  });

  it('un grupo con alguna condición no admitida se evalúa entero en memoria', () => {
    const mixed: FilterNode = { logica: 'OR', filtros: [eq, contains] };
    expect(splitFiltersForPushdown([mixed], noText)).toEqual({ pushed: [], residual: [mixed] });
  });

  it('si el motor no admite grupos, todos los grupos quedan en memoria', () => {
    expect(splitFiltersForPushdown([eq, orGroup], () => true, false)).toEqual({ pushed: [eq], residual: [orGroup] });
  });

  it('el resultado es el mismo que evaluar todo en memoria', () => {
    const filters: FilterNode[] = [eq, contains, orGroup];
    const { pushed, residual } = splitFiltersForPushdown(filters, noText);
    const twoSteps = rows.filter((row) => matchesFilters(row, pushed)).filter((row) => matchesFilters(row, residual));
    expect(twoSteps).toEqual(rows.filter((row) => matchesFilters(row, filters)));
  });
});

describe('escapes', () => {
  it('escapa comodines de LIKE con ! y metacaracteres de regex', () => {
    expect(escapeLikePattern("50%_off[!]'")).toBe("50!%!_off![!!]'");
    expect(escapeRegExp('a.b*(c)?^$|[x]\\')).toBe('a\\.b\\*\\(c\\)\\?\\^\\$\\|\\[x\\]\\\\');
  });
});

describe('rangos de fechas (filtro de fechas del explorador)', () => {
  const range = (valor: [string, string]) => [{ campo: 'fecha', operador: 'between' as const, valor }];
  const day = range(['2026-01-31T00:00:00.000Z', '2026-01-31T23:59:59.999Z']);

  it('compara fechas ISO como instantes, con o sin hora y con otra zona horaria', () => {
    expect(matchesFilters({ fecha: '2026-01-31T10:00:00.000Z' }, day)).toBe(true);
    expect(matchesFilters({ fecha: '2026-01-31' }, day)).toBe(true);
    expect(matchesFilters({ fecha: '2026-01-31T20:00:00-06:00' }, day)).toBe(false);
    expect(matchesFilters({ fecha: '2026-02-01T00:00:00.000Z' }, day)).toBe(false);
    expect(matchesFilters({ fecha: new Date('2026-01-31T12:00:00Z') }, day)).toBe(true);
    expect(matchesFilters({ fecha: null }, day)).toBe(false);
  });

  it('reconoce los rangos de fechas y rechaza uno con la fecha inicial posterior a la final', () => {
    expect(isDateRangeFilter({ campo: 'fecha', operador: 'between', valor: ['2026-01-01', '2026-01-31'] })).toBe(true);
    expect(isDateRangeFilter({ campo: 'fecha', operador: 'lte', valor: '2026-01-31T23:59:59Z' })).toBe(true);
    expect(isDateRangeFilter({ campo: 'nombre', operador: 'between', valor: ['a', 'm'] })).toBe(false);
    expect(parseIsoDate('2026-13-45')).toBeNull();
    expect(() => assertValidFilters(range(['2026-02-01', '2026-01-01']))).toThrow(/fecha inicial/);
  });
});
