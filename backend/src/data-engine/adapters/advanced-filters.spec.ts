import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { buildPostgresSelect } from './postgres.adapter.js';
import { buildMysqlSelect } from './mysql.adapter.js';
import { buildSqlFilterClauses } from './sql-filters.js';
import { buildMongoFilter } from './mongo-filters.js';
import { FirestoreAdapter } from './firestore.adapter.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';
import type { FilterNode } from '../filters/filter-tree.js';

/** Traducción de los filtros avanzados (issue #31) a cada motor, incluidos intentos de inyección. */
const COLUMNS = ['id', 'nombre', 'email', 'alta', 'total'];

const advanced: FilterNode[] = [
  { campo: 'alta', operador: 'between', valor: ['2026-01-01', '2026-03-31'] },
  {
    logica: 'OR',
    filtros: [
      { campo: 'nombre', operador: 'contains', valor: 'ana' },
      { campo: 'email', operador: 'startsWith', valor: 'ventas' },
      { logica: 'AND', filtros: [{ campo: 'total', operador: 'gte', valor: 100 }, { campo: 'email', operador: 'isNull', valor: false }] },
    ],
  },
];

const INJECTIONS = [
  "x' OR '1'='1",
  "'; DROP TABLE clientes; --",
  "%' OR 1=1 --",
  'a\\\' OR 1=1 #',
  "' UNION SELECT password FROM users --",
];

describe('PostgreSQL', () => {
  it('traduce between, contains, startsWith, isNull y grupos OR/AND anidados con parámetros $n', () => {
    const select = buildPostgresSelect('clientes', 'public', COLUMNS, advanced, 100, 1_000_000);
    expect(select.text).toContain(
      'WHERE "__dn_src"."alta" BETWEEN $1 AND $2 AND (' +
        `LOWER(CAST("__dn_src"."nombre" AS text)) LIKE $3 ESCAPE '!' OR ` +
        `LOWER(CAST("__dn_src"."email" AS text)) LIKE $4 ESCAPE '!' OR ` +
        '("__dn_src"."total" >= $5 AND "__dn_src"."email" IS NOT NULL))',
    );
    // Las fechas ISO de un rango viajan como Date: el driver las compara como fecha, no como texto.
    expect(select.values).toEqual([new Date('2026-01-01T00:00:00Z'), new Date('2026-03-31T00:00:00Z'), '%ana%', 'ventas%', 100]);
  });

  it.each(INJECTIONS)('el valor %j viaja como parámetro y nunca dentro del SQL', (payload) => {
    const select = buildPostgresSelect(
      'clientes',
      'public',
      COLUMNS,
      [
        { campo: 'nombre', operador: 'eq', valor: payload },
        { campo: 'email', operador: 'contains', valor: payload },
        { logica: 'OR', filtros: [{ campo: 'id', operador: 'in', valor: [payload, 1] }] },
      ],
      10,
      1_000,
    );
    expect(select.text).not.toContain(payload);
    expect(select.text).not.toMatch(/DROP|UNION|OR 1=1/);
    expect(select.values[0]).toBe(payload);
  });
});

describe('MySQL', () => {
  it('usa ? y CAST(... AS CHAR) para buscar texto', () => {
    const select = buildMysqlSelect('clientes', undefined, COLUMNS, advanced, 100, 1_000_000);
    expect(select.sql).toContain("LOWER(CAST(`__dn_src`.`nombre` AS CHAR)) LIKE ? ESCAPE '!'");
    expect(select.sql).toContain('`__dn_src`.`alta` BETWEEN ? AND ?');
    expect(select.params).toEqual([new Date('2026-01-01T00:00:00Z'), new Date('2026-03-31T00:00:00Z'), '%ana%', 'ventas%', 100]);
  });

  it('escapa los comodines del texto buscado', () => {
    const select = buildMysqlSelect('clientes', undefined, COLUMNS, [{ campo: 'nombre', operador: 'contains', valor: '100%_[!]' }], 10, 1_000);
    expect(select.params).toEqual(['%100!%!_![!!]%']);
  });

  it.each(INJECTIONS)('el valor %j viaja como parámetro', (payload) => {
    const select = buildMysqlSelect('clientes', undefined, COLUMNS, [{ campo: 'nombre', operador: 'startsWith', valor: payload }], 10, 1_000);
    expect(select.sql).not.toContain(payload);
  });
});

describe('SQL Server (dialecto @p y NVARCHAR)', () => {
  it('traduce grupos y operadores con parámetros con nombre', () => {
    const parameters: Record<string, unknown> = {};
    let index = 0;
    const clauses = buildSqlFilterClauses(COLUMNS, advanced, {
      column: (name) => `[src].[${name}]`,
      parameter: (value) => {
        const name = `filter_${index++}`;
        parameters[name] = value;
        return `@${name}`;
      },
      text: (column) => `CAST(${column} AS NVARCHAR(4000))`,
    });
    expect(clauses).toEqual([
      '[src].[alta] BETWEEN @filter_0 AND @filter_1',
      "(LOWER(CAST([src].[nombre] AS NVARCHAR(4000))) LIKE @filter_2 ESCAPE '!' OR " +
        "LOWER(CAST([src].[email] AS NVARCHAR(4000))) LIKE @filter_3 ESCAPE '!' OR " +
        '([src].[total] >= @filter_4 AND [src].[email] IS NOT NULL))',
    ]);
    expect(parameters).toEqual({ filter_0: new Date('2026-01-01T00:00:00Z'), filter_1: new Date('2026-03-31T00:00:00Z'), filter_2: '%ana%', filter_3: 'ventas%', filter_4: 100 });
  });
});

describe('Todos los motores SQL rechazan', () => {
  const dialect = { column: (name: string) => `"${name}"`, parameter: () => '?' };
  it.each<[string, FilterNode[]]>([
    ['un campo que no existe (también dentro de un grupo)', [{ logica: 'OR', filtros: [{ campo: 'id; DROP TABLE x', operador: 'eq', valor: 1 }] }]],
    ['un valor objeto', [{ campo: 'id', operador: 'eq', valor: { $gt: 1 } } as never]],
    ['un operador desconocido', [{ campo: 'id', operador: 'like', valor: '%' } as never]],
    ['between al revés', [{ campo: 'total', operador: 'between', valor: [10, 1] }]],
  ])('%s', (_reason, filters) => {
    expect(() => buildSqlFilterClauses(COLUMNS, filters, dialect)).toThrow(BadRequestException);
  });
});

describe('MongoDB', () => {
  it('traduce grupos a $or/$and y los operadores nuevos', () => {
    expect(buildMongoFilter(advanced)).toEqual({
      $and: [
        // Un rango de fechas encuentra campos Date y también fechas guardadas como texto ISO.
        { $or: [{ alta: { $gte: new Date('2026-01-01T00:00:00Z'), $lte: new Date('2026-03-31T00:00:00Z') } }, { alta: { $gte: '2026-01-01', $lte: '2026-03-31' } }] },
        {
          $or: [
            { nombre: { $regex: 'ana', $options: 'i' } },
            { email: { $regex: '^ventas', $options: 'i' } },
            { $and: [{ total: { $gte: 100 } }, { email: { $ne: null } }] },
          ],
        },
      ],
    });
  });

  it('escapa los metacaracteres de regex: el texto se busca literalmente (sin ReDoS ni comodines)', () => {
    expect(buildMongoFilter([{ campo: 'nombre', operador: 'contains', valor: '.*(a+)+$' }])).toEqual({
      nombre: { $regex: '\\.\\*\\(a\\+\\)\\+\\$', $options: 'i' },
    });
  });

  it('isNull se traduce a $eq / $ne null', () => {
    expect(buildMongoFilter([{ campo: 'baja', operador: 'isNull', valor: true }])).toEqual({ baja: { $eq: null } });
  });

  it('rechaza operadores inyectados en campos dentro de grupos', () => {
    expect(() =>
      buildMongoFilter([{ logica: 'OR', filtros: [{ campo: '$where', operador: 'eq', valor: 'sleep(1000)' }] }]),
    ).toThrow(BadRequestException);
  });
});

describe('Firestore', () => {
  const adapter = new FirestoreAdapter(new DataSourceClientPool());

  it('declara qué puede ejecutar en el servidor: no texto ni grupos', () => {
    expect(adapter.pushesFilterGroups).toBe(false);
    for (const operador of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not-in', 'between', 'isNull'] as const) {
      expect(adapter.canPushDown({ campo: 'a', operador, valor: 1 })).toBe(true);
    }
    expect(adapter.canPushDown({ campo: 'a', operador: 'contains', valor: 'x' })).toBe(false);
    expect(adapter.canPushDown({ campo: 'a', operador: 'startsWith', valor: 'x' })).toBe(false);
  });
});
