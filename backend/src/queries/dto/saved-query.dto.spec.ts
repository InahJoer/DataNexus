import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CrossJoinDto } from '../../data-engine/dto/cross-join.dto.js';
import { CreateSavedQueryDto, RunSavedQueryDto, UpdateSavedQueryDto } from './saved-query.dto.js';

/** Misma configuración que main.ts. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const body = (metatype: new () => object, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype });

const definicion = {
  conexionSqlId: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
  conexionNoSqlId: 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e',
  tablaSql: 'clients',
  coleccionNoSql: 'orders',
  llaveSql: 'id',
  llaveNoSql: 'client_id',
};

describe('DTOs de consultas guardadas con el ValidationPipe global', () => {
  it('convierte la definición en CrossJoinDto', async () => {
    const dto = (await body(CreateSavedQueryDto, { nombre: 'Clientes', definicion })) as CreateSavedQueryDto;
    expect(dto.definicion).toBeInstanceOf(CrossJoinDto);
  });

  it.each([
    ['sin nombre', { definicion }],
    ['sin definición', { nombre: 'x' }],
    ['definición vacía', { nombre: 'x', definicion: {} }],
    ['propiedad desconocida en la definición', { nombre: 'x', definicion: { ...definicion, sql: 'DROP TABLE' } }],
    ['filtro con operador no permitido', { nombre: 'x', definicion: { ...definicion, filtrosSql: [{ campo: 'a', operador: 'raw', valor: 1 }] } }],
    ['visibilidad desconocida', { nombre: 'x', definicion, visibilidad: 'PUBLICA' }],
  ])('rechaza %s', async (_caso, value) => {
    await expect(body(CreateSavedQueryDto, value)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('permite actualizaciones parciales', async () => {
    await expect(body(UpdateSavedQueryDto, { visibilidad: 'PUBLICADA' })).resolves.toBeTruthy();
  });

  it('valida la paginación de la ejecución', async () => {
    await expect(body(RunSavedQueryDto, { limit: 5000 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(body(RunSavedQueryDto, { version: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(body(RunSavedQueryDto, {})).resolves.toEqual({});
  });
});
