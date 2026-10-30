import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CrossJoinDto } from './cross-join.dto.js';

const basePayload = {
  conexionSqlId: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
  conexionNoSqlId: 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e',
  tablaSql: 'clients',
  coleccionNoSql: 'orders',
  llaveSql: 'id',
  llaveNoSql: 'client_id',
};

const validationErrors = (payload: Record<string, unknown>) =>
  validate(plainToInstance(CrossJoinDto, { ...basePayload, ...payload }));

describe('CrossJoinDto data pipeline options', () => {
  it('accepts typed source filters and post-join aggregates', async () => {
    const errors = await validationErrors({
      filtrosSql: [{ campo: 'status', operador: 'eq', valor: 'active' }],
      filtrosNoSql: [
        { campo: 'amount', operador: 'gte', valor: 10 },
        { campo: 'status', operador: 'in', valor: ['paid', 'pending'] },
      ],
      groupBy: ['status'],
      limit: 10,
      offset: 2,
      aggregations: [
        { operation: 'COUNT', as: 'orders' },
        { operation: 'SUM', field: 'amount', as: 'total' },
        { operation: 'AVG', field: 'amount', as: 'average' },
      ],
    });

    expect(errors).toEqual([]);
  });

  it('rejects filter operators outside the allowlist', async () => {
    const errors = await validationErrors({
      filtrosSql: [{ campo: 'status', operador: 'raw', valor: 'active' }],
    });

    expect(errors[0]?.property).toBe('filtrosSql');
  });

  it('rejects empty and oversized membership filters', async () => {
    const empty = await validationErrors({
      filtrosSql: [{ campo: 'id', operador: 'in', valor: [] }],
    });
    const oversized = await validationErrors({
      filtrosNoSql: [
        {
          campo: 'id',
          operador: 'not-in',
          valor: Array.from({ length: 11 }, (_, index) => index),
        },
      ],
    });

    expect(empty[0]?.property).toBe('filtrosSql');
    expect(oversized[0]?.property).toBe('filtrosNoSql');
  });

  it('allows null only for equality and inequality filters', async () => {
    const errors = await validationErrors({
      filtrosSql: [{ campo: 'status', operador: 'gt', valor: null }],
    });

    expect(errors[0]?.property).toBe('filtrosSql');
  });

  it.each(['SUM', 'AVG'])('requires a field for %s', async (operation) => {
    const errors = await validationErrors({
      aggregations: [{ operation, as: 'result' }],
    });

    expect(errors[0]?.property).toBe('aggregations');
  });
});
