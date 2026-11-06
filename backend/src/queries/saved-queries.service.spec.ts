import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import type { UserRole } from '../auth/interfaces/user-role.js';
import type { DataEngineService } from '../data-engine/data-engine.service.js';
import { CrossJoinDto } from '../data-engine/dto/cross-join.dto.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SavedQueriesService, toStoredDefinition } from './saved-queries.service.js';

const IDS = {
  erp: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
  app: 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e',
  query: 'c3d4e5f6-a7b8-4c9d-8e1f-3a4b5c6d7e8f',
};

const user = (role: UserRole, id = `${role.toLowerCase()}-1`): AuthenticatedUser => ({
  id,
  email: `${id}@empresa.com`,
  name: id,
  role,
  workspaceId: 'workspace-1',
});

const admin = user('ADMIN');
const operador = user('OPERADOR');
const otroOperador = user('OPERADOR', 'operador-2');
const lector = user('LECTOR');

/** Join de varias fuentes con filtros anidados, tipos LEFT y límite de filas: el caso más completo. */
const originalJoinBody = () => ({
  fuentes: [
    {
      alias: 'clientes',
      conexionId: IDS.erp,
      entidad: 'clientes',
      esquema: 'dbo',
      filtros: [
        {
          logica: 'OR',
          filtros: [
            { campo: 'pais', operador: 'eq', valor: 'NI' },
            { campo: 'pais', operador: 'eq', valor: 'CR' },
          ],
        },
      ],
    },
    { alias: 'pedidos', conexionId: IDS.app, entidad: 'pedidos' },
  ],
  relaciones: [
    { izquierda: 'clientes', derecha: 'pedidos', tipo: 'LEFT', llaves: [{ izquierda: 'id', derecha: 'cliente_id' }] },
  ],
  groupBy: ['clientes.pais'],
  aggregations: [{ operation: 'COUNT', as: 'pedidos' }],
  limiteFilas: 100,
  limit: 25,
  offset: 50,
});

/** Lo que el ValidationPipe global entrega al controlador de POST /engine/join. */
async function asValidatedDto(body: Record<string, unknown>): Promise<CrossJoinDto> {
  const dto = plainToInstance(CrossJoinDto, body);
  expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  return dto;
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  const definicion = toStoredDefinition(plainToInstance(CrossJoinDto, originalJoinBody()));
  return {
    id: IDS.query,
    workspaceId: 'workspace-1',
    nombre: 'Pedidos por país',
    descripcion: null,
    definicion,
    version: 1,
    visibilidad: 'PRIVADA',
    autorId: operador.id,
    autor: { id: operador.id, name: operador.name },
    createdAt: new Date('2026-11-06T00:00:00Z'),
    updatedAt: new Date('2026-11-06T00:00:00Z'),
    ...overrides,
  };
}

function setup() {
  const tx = {
    savedQuery: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    savedQueryVersion: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    savedQuery: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    savedQueryVersion: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    conexionDB: { count: vi.fn().mockResolvedValue(2) },
  };
  const dataEngine = {
    executeCrossJoin: vi.fn().mockResolvedValue({ total: 2, limit: 25, offset: 50, data: [{ a: 1 }, { a: 2 }] }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new SavedQueriesService(
    prisma as unknown as PrismaService,
    dataEngine as unknown as DataEngineService,
    audit as unknown as AuditService,
  );
  return { service, prisma, tx, dataEngine, audit };
}

describe('SavedQueriesService (issue #35)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  describe('crear', () => {
    it('guarda la definición sin paginación, crea la versión 1 y audita', async () => {
      ctx.tx.savedQuery.create.mockImplementation(async ({ data }) => makeRecord({ definicion: data.definicion }));
      const definicion = await asValidatedDto(originalJoinBody());

      const result = await ctx.service.create(operador, { nombre: ' Pedidos por país ', definicion });

      const { data } = ctx.tx.savedQuery.create.mock.calls[0][0];
      expect(data).toMatchObject({ nombre: 'Pedidos por país', autorId: operador.id, visibilidad: 'PRIVADA' });
      expect(data.definicion).not.toHaveProperty('limit');
      expect(data.definicion).not.toHaveProperty('offset');
      expect(data.definicion).toMatchObject({ limiteFilas: 100, groupBy: ['clientes.pais'] });
      expect(data.versiones.create).toEqual({ version: 1, definicion: data.definicion, autorId: operador.id });
      expect(ctx.prisma.conexionDB.count).toHaveBeenCalledWith({
        where: { id: { in: [IDS.erp, IDS.app] }, workspaceId: 'workspace-1' },
      });
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'SAVED_QUERY_CREATED', targetType: 'SAVED_QUERY', targetId: IDS.query }),
        ctx.tx,
      );
      expect(result.version).toBe(1);
    });

    it('rechaza conexiones que no son del workspace', async () => {
      ctx.prisma.conexionDB.count.mockResolvedValue(1);
      const definicion = await asValidatedDto(originalJoinBody());

      await expect(ctx.service.create(operador, { nombre: 'x', definicion })).rejects.toBeInstanceOf(NotFoundException);
      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('responde 409 si el nombre ya existe en el workspace', async () => {
      ctx.tx.savedQuery.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
      );
      const definicion = await asValidatedDto(originalJoinBody());

      await expect(ctx.service.create(operador, { nombre: 'x', definicion })).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([lector, user('AUDITOR')])('no permite crear al rol $role', async (actor) => {
      const definicion = await asValidatedDto(originalJoinBody());
      await expect(ctx.service.create(actor, { nombre: 'x', definicion })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('visibilidad', () => {
    it('el LECTOR solo lista publicadas y sin la definición', async () => {
      ctx.prisma.savedQuery.findMany.mockResolvedValue([makeRecord({ visibilidad: 'PUBLICADA' })]);

      const [query] = await ctx.service.findAll(lector, { visibilidad: 'PRIVADA' });

      expect(ctx.prisma.savedQuery.findMany.mock.calls[0][0].where).toEqual({
        workspaceId: 'workspace-1',
        visibilidad: 'PUBLICADA',
      });
      expect(query.definicion).toBeNull();
    });

    it('ADMIN y OPERADOR ven privadas y la definición', async () => {
      ctx.prisma.savedQuery.findMany.mockResolvedValue([makeRecord()]);

      const [query] = await ctx.service.findAll(operador);

      expect(ctx.prisma.savedQuery.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 'workspace-1' });
      expect(query.definicion).toMatchObject({ limiteFilas: 100 });
    });

    it('una consulta privada responde 404 al LECTOR', async () => {
      ctx.prisma.savedQuery.findFirst.mockResolvedValue(null);

      await expect(ctx.service.findOne(lector, IDS.query)).rejects.toBeInstanceOf(NotFoundException);
      expect(ctx.prisma.savedQuery.findFirst.mock.calls[0][0].where).toEqual({
        id: IDS.query,
        workspaceId: 'workspace-1',
        visibilidad: 'PUBLICADA',
      });
    });
  });

  describe('versionado', () => {
    beforeEach(() => {
      ctx.prisma.savedQuery.findFirst.mockResolvedValue(makeRecord({ version: 2 }));
      ctx.tx.savedQuery.update.mockImplementation(async ({ data }) => makeRecord({ ...data }));
    });

    it('un cambio real de la definición crea la versión siguiente', async () => {
      const definicion = await asValidatedDto({ ...originalJoinBody(), limiteFilas: 500 });

      const result = await ctx.service.update(operador, IDS.query, { definicion });

      expect(ctx.tx.savedQueryVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ savedQueryId: IDS.query, version: 3, autorId: operador.id }),
      });
      expect(ctx.tx.savedQuery.update.mock.calls[0][0].data).toMatchObject({ version: 3 });
      expect(result.version).toBe(3);
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'SAVED_QUERY_UPDATED', details: { changedFields: ['definicion'], version: 3 } }),
        ctx.tx,
      );
    });

    it('cambiar solo la paginación o la visibilidad no crea versión', async () => {
      const definicion = await asValidatedDto({ ...originalJoinBody(), limit: 10, offset: 0 });

      await ctx.service.update(operador, IDS.query, { definicion, visibilidad: 'PUBLICADA' });

      expect(ctx.tx.savedQueryVersion.create).not.toHaveBeenCalled();
      expect(ctx.tx.savedQuery.update.mock.calls[0][0].data).toEqual({ visibilidad: 'PUBLICADA' });
    });

    it('sin cambios no escribe ni audita', async () => {
      await ctx.service.update(operador, IDS.query, { nombre: 'Pedidos por país' });

      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
      expect(ctx.audit.record).not.toHaveBeenCalled();
    });

    it('otro OPERADOR no puede modificarla, un ADMIN sí', async () => {
      await expect(
        ctx.service.update(otroOperador, IDS.query, { visibilidad: 'PUBLICADA' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(ctx.service.remove(otroOperador, IDS.query)).rejects.toBeInstanceOf(ForbiddenException);

      await ctx.service.update(admin, IDS.query, { visibilidad: 'PUBLICADA' });
      expect(ctx.tx.savedQuery.update).toHaveBeenCalled();
    });

    it('lista el historial de versiones', async () => {
      ctx.prisma.savedQueryVersion.findMany.mockResolvedValue([
        { version: 2, definicion: { limiteFilas: 500 }, createdAt: new Date(), autor: null },
      ]);

      const versions = await ctx.service.listVersions(operador, IDS.query);

      expect(versions).toEqual([expect.objectContaining({ version: 2, autor: null })]);
      expect(ctx.prisma.savedQueryVersion.findMany.mock.calls[0][0]).toMatchObject({
        where: { savedQueryId: IDS.query },
        orderBy: { version: 'desc' },
      });
    });
  });

  describe('ejecutar', () => {
    it('se ejecuta igual que el join original', async () => {
      const original = await asValidatedDto(originalJoinBody());
      ctx.prisma.savedQuery.findFirst.mockResolvedValue(
        // Se guarda y se vuelve a leer como JSON, igual que en PostgreSQL.
        makeRecord({ definicion: JSON.parse(JSON.stringify(toStoredDefinition(original))) }),
      );

      const result = await ctx.service.run(operador, IDS.query, { limit: original.limit, offset: original.offset });

      const [payload, actor] = ctx.dataEngine.executeCrossJoin.mock.calls[0];
      expect(payload).toBeInstanceOf(CrossJoinDto);
      expect(payload).toEqual(original);
      expect(actor).toBe(operador);
      expect(result).toMatchObject({ total: 2, consultaId: IDS.query, version: 1 });
    });

    it('usa la paginación por defecto del motor si no se indica', async () => {
      ctx.prisma.savedQuery.findFirst.mockResolvedValue(makeRecord());

      await ctx.service.run(operador, IDS.query);

      const [payload] = ctx.dataEngine.executeCrossJoin.mock.calls[0];
      expect(payload).toMatchObject({ limit: 50, offset: 0 });
    });

    it('el LECTOR ejecuta una publicada con su propio rol (enmascaramiento)', async () => {
      ctx.prisma.savedQuery.findFirst.mockResolvedValue(makeRecord({ visibilidad: 'PUBLICADA' }));

      await ctx.service.run(lector, IDS.query);

      expect(ctx.dataEngine.executeCrossJoin.mock.calls[0][1]).toBe(lector);
    });

    it('el LECTOR no puede ejecutar una privada', async () => {
      ctx.prisma.savedQuery.findFirst.mockResolvedValue(null);

      await expect(ctx.service.run(lector, IDS.query)).rejects.toBeInstanceOf(NotFoundException);
      expect(ctx.dataEngine.executeCrossJoin).not.toHaveBeenCalled();
    });

    it('el LECTOR no puede elegir una versión anterior', async () => {
      ctx.prisma.savedQuery.findFirst.mockResolvedValue(makeRecord({ visibilidad: 'PUBLICADA', version: 3 }));

      await expect(ctx.service.run(lector, IDS.query, { version: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ejecuta una versión anterior desde el historial', async () => {
      ctx.prisma.savedQuery.findFirst.mockResolvedValue(makeRecord({ version: 3 }));
      ctx.prisma.savedQueryVersion.findUnique.mockResolvedValue({
        definicion: { ...makeRecord().definicion, limiteFilas: 1000 },
      });

      const result = await ctx.service.run(operador, IDS.query, { version: 1 });

      expect(ctx.prisma.savedQueryVersion.findUnique).toHaveBeenCalledWith({
        where: { savedQueryId_version: { savedQueryId: IDS.query, version: 1 } },
        select: { definicion: true },
      });
      expect(ctx.dataEngine.executeCrossJoin.mock.calls[0][0]).toMatchObject({ limiteFilas: 1000 });
      expect(result.version).toBe(1);
    });

    it('responde 422 si la definición guardada ya no es válida', async () => {
      ctx.prisma.savedQuery.findFirst.mockResolvedValue(
        makeRecord({ definicion: { ...makeRecord().definicion, limiteFilas: 7 } }),
      );

      await expect(ctx.service.run(operador, IDS.query)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(ctx.dataEngine.executeCrossJoin).not.toHaveBeenCalled();
    });
  });
});
