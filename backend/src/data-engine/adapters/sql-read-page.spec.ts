import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';

/** Paginación por cursor (issue #32) en MySQL y SQL Server: SQL generado y parámetros, con los drivers simulados. */
const mocks = vi.hoisted(() => ({
  mysqlCalls: [] as Array<{ sql: string; params: unknown[] }>,
  mysqlKeys: ['id'] as string[],
  mssqlQueries: [] as string[],
  mssqlInputs: {} as Record<string, unknown>,
  mssqlKeys: ['id'] as string[],
}));

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: vi.fn(() => ({
      on: vi.fn(),
      end: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string, params: unknown[]) => {
        mocks.mysqlCalls.push({ sql, params });
        if (sql.includes('information_schema.columns')) return [['id', 'nombre', 'pais'].map((COLUMN_NAME) => ({ COLUMN_NAME })), []];
        if (sql.includes('KEY_COLUMN_USAGE')) return [mocks.mysqlKeys.map((COLUMN_NAME) => ({ COLUMN_NAME })), []];
        return [[{ id: 4, nombre: 'Ana', pais: 'NI' }, { id: 5, nombre: 'Luis', pais: 'NI' }, { id: 6, nombre: 'Eva', pais: 'NI' }], []];
      }),
    })),
  },
}));

vi.mock('mssql', () => {
  class ConnectionPool {
    static parseConnectionString = () => ({ pool: {} });
    on() {}
    connect = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    request() {
      return {
        input: (name: string, value: unknown) => {
          mocks.mssqlInputs[name] = value;
        },
        query: vi.fn(async (query: string) => {
          mocks.mssqlQueries.push(query);
          if (query.includes('[sys].[columns]')) return { recordset: ['id', 'nombre'].map((name) => ({ name })) };
          if (query.includes('is_primary_key')) return { recordset: mocks.mssqlKeys.map((name) => ({ name })) };
          return { recordset: [{ id: 11, nombre: 'Ana' }, { id: 12, nombre: 'Luis' }] };
        }),
      };
    }
  }
  return { default: { ConnectionPool, NVarChar: () => 'nvarchar' }, ConnectionPool };
});

import { MysqlAdapter } from './mysql.adapter.js';
import { SqlServerAdapter } from './sqlserver.adapter.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';

const mysqlConnection = { id: 'my-1', tipoMotor: 'MYSQL', dbName: 'crm', connectionString: 'mysql://u:p@db:3306/crm' };
const mssqlConnection = { id: 'ms-1', tipoMotor: 'SQLSERVER', dbName: 'erp', connectionString: 'Server=db;Database=erp' };

describe('MySQL readPage', () => {
  let pool: DataSourceClientPool;
  afterEach(async () => {
    mocks.mysqlCalls.length = 0;
    mocks.mysqlKeys = ['id'];
    await pool.onModuleDestroy();
  });

  it('ordena por la llave primaria, avanza con keyset y pide limite + 1 filas, con parámetros ?', async () => {
    pool = new DataSourceClientPool();
    const page = await new MysqlAdapter(pool).readPage(mysqlConnection, 'clientes', {
      pageSize: 2,
      after: [3],
      filters: [{ campo: 'pais', operador: 'eq', valor: "NI' OR 1=1 --" }],
    });
    const select = mocks.mysqlCalls.at(-1)!;
    expect(select.sql).toContain('WHERE `__dn_src`.`pais` = ? AND (`__dn_src`.`id` > ?)');
    expect(select.sql).toMatch(/ORDER BY `__dn_src`\.`id` LIMIT 3$/);
    expect(select.sql).not.toContain('OFFSET');
    expect(select.params).toEqual(["NI' OR 1=1 --", 3]);
    expect(page).toEqual({
      rows: [
        { id: 4, nombre: 'Ana', pais: 'NI' },
        { id: 5, nombre: 'Luis', pais: 'NI' },
      ],
      orderBy: ['id'],
      lastKey: [5],
    });
  });

  it('con llave compuesta usa un parámetro por aparición (cada ? consume un valor)', async () => {
    pool = new DataSourceClientPool();
    mocks.mysqlKeys = ['pais', 'id'];
    await new MysqlAdapter(pool).readPage(mysqlConnection, 'clientes', { pageSize: 2, after: ['NI', 3] });
    const select = mocks.mysqlCalls.at(-1)!;
    expect(select.sql).toContain('((`__dn_src`.`pais` > ?) OR (`__dn_src`.`pais` = ? AND `__dn_src`.`id` > ?))');
    expect(select.params).toEqual(['NI', 'NI', 3]);
    expect(select.sql.split('?').length - 1).toBe(select.params.length);
  });

  it('sin llave primaria responde 400', async () => {
    pool = new DataSourceClientPool();
    mocks.mysqlKeys = [];
    await expect(new MysqlAdapter(pool).readPage(mysqlConnection, 'log', { pageSize: 2 })).rejects.toThrow(/no tiene llave primaria/);
  });
});

describe('SQL Server readPage', () => {
  let pool: DataSourceClientPool;
  afterEach(async () => {
    mocks.mssqlQueries.length = 0;
    mocks.mssqlInputs = {};
    mocks.mssqlKeys = ['id'];
    await pool.onModuleDestroy();
  });

  it('usa TOP (limite + 1), ORDER BY por la llave primaria y parámetros con nombre', async () => {
    pool = new DataSourceClientPool();
    const page = await new SqlServerAdapter(pool).readPage(mssqlConnection, 'Clientes', {
      schema: 'dbo',
      pageSize: 1,
      after: [10],
      filters: [{ campo: 'nombre', operador: 'startsWith', valor: 'an' }],
    });
    const select = mocks.mssqlQueries.at(-1)!;
    expect(select).toMatch(/^SELECT TOP \(2\) /);
    expect(select).toContain(
      "WHERE LOWER(CAST([__dataNexusSource].[nombre] AS NVARCHAR(4000))) LIKE @p_0 ESCAPE '!' AND ([__dataNexusSource].[id] > @p_1)",
    );
    expect(select).toMatch(/ORDER BY \[__dataNexusSource\]\.\[id\]$/);
    expect(mocks.mssqlInputs).toEqual({ p_0: 'an%', p_1: 10 });
    expect(page).toEqual({ rows: [{ id: 11, nombre: 'Ana' }], orderBy: ['id'], lastKey: [11] });
  });

  it('sin llave primaria responde 400', async () => {
    pool = new DataSourceClientPool();
    mocks.mssqlKeys = [];
    await expect(new SqlServerAdapter(pool).readPage(mssqlConnection, 'Log', { pageSize: 2 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
