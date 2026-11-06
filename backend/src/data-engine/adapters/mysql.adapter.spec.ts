import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

const mocks = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  query: vi.fn(),
  end: vi.fn(),
  release: vi.fn(),
  destroy: vi.fn(),
  streamed: [] as Array<{ sql: string; params: unknown[] }>,
  rows: [] as Array<Record<string, unknown>>,
  streamError: undefined as Error | undefined,
}));

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: vi.fn((config: Record<string, unknown>) => {
      mocks.configs.push(config);
      return {
        on: vi.fn(),
        query: mocks.query,
        end: mocks.end,
        getConnection: vi.fn(async () => ({
          release: mocks.release,
          destroy: mocks.destroy,
          connection: {
            query: (sql: string, params: unknown[]) => {
              mocks.streamed.push({ sql, params });
              return {
                stream: () => {
                  if (mocks.streamError) {
                    const failing = new Readable({ objectMode: true, read() {} });
                    process.nextTick(() => failing.destroy(mocks.streamError));
                    return failing;
                  }
                  return Readable.from(mocks.rows.map((row) => ({ ...row })), { objectMode: true });
                },
              };
            },
          },
        })),
      };
    }),
  },
}));

import { MysqlAdapter, buildMysqlSelect, quoteMysqlIdentifier } from './mysql.adapter.js';
import { DataSourceClientPool } from '../pool/data-source-client-pool.js';

const connection = {
  id: 'mysql-1',
  tipoMotor: 'MYSQL',
  dbName: 'ventas',
  connectionString: 'mysql://lector%40bi:p%40ss%3Aw%2Frd@db.internal:3307/otra?ssl=true',
};
const COLUMNS = ['id', 'cliente_id', 'total', 'foto'];

describe('buildMysqlSelect', () => {
  it('limita filas, corta por tiempo en el servidor y escapa identificadores', () => {
    const select = buildMysqlSelect('pedidos', 'ventas', COLUMNS, [], 100, 1_000_000);
    expect(select.sql).toContain('/*+ MAX_EXECUTION_TIME(8000) */');
    expect(select.sql).toContain('FROM `ventas`.`pedidos` AS `__dn_src`');
    expect(select.sql).toMatch(/LIMIT 101$/);
    expect(select.params).toEqual([]);
    for (const column of COLUMNS) expect(select.sql).toContain(`\`__dn_src\`.\`${column}\``);
    expect(select.sql).toContain('> 1000000');
  });

  it('traduce los filtros a parámetros ? sin concatenar valores (filter pushdown)', () => {
    const malicious = "x' OR '1'='1'; DROP TABLE pedidos; --";
    const select = buildMysqlSelect(
      'pedidos',
      undefined,
      COLUMNS,
      [
        { campo: 'cliente_id', operador: 'eq', valor: malicious },
        { campo: 'total', operador: 'gte', valor: 10 },
        { campo: 'id', operador: 'in', valor: [1, 2, 3] },
        { campo: 'foto', operador: 'eq', valor: null },
      ],
      100,
      1_000,
    );
    expect(select.sql).toContain(
      'WHERE `__dn_src`.`cliente_id` = ? AND `__dn_src`.`total` >= ? AND `__dn_src`.`id` IN (?, ?, ?) AND `__dn_src`.`foto` IS NULL',
    );
    expect(select.params).toEqual([malicious, 10, 1, 2, 3]);
    expect(select.sql).not.toContain('DROP TABLE');
  });

  it('escapa comillas invertidas en nombres de tabla y columna', () => {
    expect(quoteMysqlIdentifier('a`b; DROP TABLE x', 'tabla')).toBe('`a``b; DROP TABLE x`');
    const select = buildMysqlSelect('pe`didos', undefined, ['co`l'], [], 10, 1_000);
    expect(select.sql).toContain('FROM `pe``didos`');
    expect(select.sql).toContain('`co``l`');
  });

  it.each([
    ['vacío', ''],
    ['con NUL', 'a\0b'],
    ['demasiado largo', 'x'.repeat(65)],
  ])('rechaza un identificador %s', (_label, name) => {
    expect(() => quoteMysqlIdentifier(name, 'tabla')).toThrow(BadRequestException);
  });

  it.each([
    ['un campo que no existe', { campo: 'password', operador: 'eq', valor: 'x' }],
    ['un operador desconocido', { campo: 'id', operador: 'like', valor: 'x' }],
    ['una lista vacía', { campo: 'id', operador: 'in', valor: [] }],
    ['una lista de más de 10', { campo: 'id', operador: 'in', valor: Array.from({ length: 11 }, (_, i) => i) }],
    ['un objeto como valor', { campo: 'id', operador: 'eq', valor: { $gt: 1 } }],
    ['null con un operador de orden', { campo: 'id', operador: 'gt', valor: null }],
  ])('rechaza %s', (_label, filter) => {
    expect(() => buildMysqlSelect('pedidos', undefined, COLUMNS, [filter as never], 10, 1_000)).toThrow(
      BadRequestException,
    );
  });

  it('elige un nombre de columna auxiliar que no choca con columnas reales', () => {
    const select = buildMysqlSelect('t', undefined, ['__dn_oversized', '__dn_row_bytes'], [], 10, 1_000);
    expect(select.oversizedKey).toBe('__dn_oversized_2');
    expect(select.sql).toContain('`__dn_row_bytes_2`');
  });
});

describe('MysqlAdapter', () => {
  let pool: DataSourceClientPool;
  let adapter: MysqlAdapter;

  beforeEach(() => {
    mocks.configs.length = 0;
    mocks.streamed.length = 0;
    mocks.rows = [];
    mocks.streamError = undefined;
    mocks.query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.columns')) return [COLUMNS.map((name) => ({ COLUMN_NAME: name })), []];
      return [[{ TABLE_SCHEMA: 'ventas', TABLE_NAME: 'pedidos', TABLE_TYPE: 'BASE TABLE' }], []];
    });
    mocks.end.mockReset().mockResolvedValue(undefined);
    mocks.release.mockReset();
    mocks.destroy.mockReset();
    pool = new DataSourceClientPool();
    adapter = new MysqlAdapter(pool);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool.onModuleDestroy();
  });

  it('crea el pool con las credenciales decodificadas, el dbName del registro y TLS', async () => {
    await adapter.listObjects(connection);
    expect(mocks.configs[0]).toMatchObject({
      host: 'db.internal',
      port: 3307,
      user: 'lector@bi',
      password: 'p@ss:w/rd',
      database: 'ventas',
      ssl: {},
      multipleStatements: false,
      decimalNumbers: true,
    });
  });

  it('reutiliza el mismo pool entre operaciones y lo cierra al invalidar la conexión', async () => {
    await adapter.listObjects(connection);
    await adapter.listFields(connection, 'pedidos');
    await adapter.extract(connection, 'pedidos');
    expect(mocks.configs).toHaveLength(1);

    await pool.invalidate('mysql-1');
    expect(mocks.end).toHaveBeenCalledOnce();
    await adapter.listObjects(connection);
    expect(mocks.configs).toHaveLength(2);
  });

  it('lista tablas y vistas de la base actual y los campos con parámetros', async () => {
    await expect(adapter.listObjects(connection)).resolves.toEqual([
      { name: 'pedidos', schema: 'ventas', type: 'TABLE' },
    ]);
    await expect(adapter.listFields(connection, 'pedidos', 'ventas')).resolves.toEqual(COLUMNS);
    const [sql, params] = mocks.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?');
    expect(params).toEqual(['ventas', 'pedidos']);
  });

  it('extrae filas con filtros, quita la columna auxiliar, pasa binarios a base64 y libera la conexión', async () => {
    mocks.rows = [
      { id: 1, cliente_id: 'C1', total: 10.5, foto: Buffer.from('png'), __dn_oversized: 0 },
      { id: 2, cliente_id: 'C2', total: 20, foto: null, __dn_oversized: 0 },
    ];
    const rows = await adapter.extract(connection, 'pedidos', {
      filters: [{ campo: 'total', operador: 'gt', valor: 5 }],
    });

    expect(rows).toEqual([
      { id: 1, cliente_id: 'C1', total: 10.5, foto: Buffer.from('png').toString('base64') },
      { id: 2, cliente_id: 'C2', total: 20, foto: null },
    ]);
    expect(mocks.streamed[0].params).toEqual([5]);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it('rechaza una tabla inexistente o sin columnas visibles', async () => {
    mocks.query.mockResolvedValue([[], []]);
    await expect(adapter.extract(connection, 'no_existe')).rejects.toThrow(BadRequestException);
    expect(mocks.streamed).toHaveLength(0);
  });

  it('rechaza nombres de tabla inválidos antes de consultar', async () => {
    await expect(adapter.extract(connection, 'x'.repeat(65))).rejects.toThrow(BadRequestException);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('corta con 413 si la fuente supera el máximo de filas y descarta la conexión', async () => {
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_ROWS', '2');
    mocks.rows = [1, 2, 3].map((id) => ({ id, cliente_id: 'C', total: 1, foto: null, __dn_oversized: 0 }));
    await expect(adapter.extract(connection, 'pedidos')).rejects.toThrow(PayloadTooLargeException);
    expect(mocks.streamed[0].sql).toMatch(/LIMIT 3$/);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('corta con 413 si el servidor marca una fila como demasiado grande', async () => {
    mocks.rows = [{ id: 1, cliente_id: null, total: null, foto: null, __dn_oversized: 1 }];
    await expect(adapter.extract(connection, 'pedidos')).rejects.toThrow(/Una fila de la fuente supera/);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it('corta con 413 si el total de bytes supera el máximo', async () => {
    vi.stubEnv('DATA_ENGINE_MAX_SOURCE_BYTES', '120');
    mocks.rows = [1, 2, 3].map((id) => ({ id, cliente_id: 'C'.repeat(30), total: 1, foto: null, __dn_oversized: 0 }));
    await expect(adapter.extract(connection, 'pedidos')).rejects.toThrow(/bytes configurado/);
  });

  it('propaga errores del driver y descarta la conexión', async () => {
    mocks.streamError = Object.assign(new Error('MySQL query timeout'), { code: 'ETIMEDOUT' });
    await expect(adapter.extract(connection, 'pedidos')).rejects.toThrow('MySQL query timeout');
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it('rechaza cadenas que no son de MySQL', async () => {
    await expect(adapter.listObjects({ ...connection, connectionString: 'postgres://x' })).rejects.toThrow(
      'Invalid MySQL connection configuration',
    );
  });
});
