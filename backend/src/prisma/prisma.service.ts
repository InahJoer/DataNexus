import { ForbiddenException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/** Modelos de solo inserción. La base de datos los protege además con un trigger (migración auditoria_inmutable). */
export const APPEND_ONLY_MODELS: ReadonlySet<string> = new Set(['RegistroAuditoria']);

const BLOCKED_ACTIONS: ReadonlySet<string> = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/**
 * Middleware que rechaza en la aplicación cualquier modificación o borrado de la bitácora,
 * antes de que la consulta llegue a PostgreSQL.
 */
export const appendOnlyGuard: Prisma.Middleware = (params, next) => {
  if (params.model && APPEND_ONLY_MODELS.has(params.model) && BLOCKED_ACTIONS.has(params.action)) {
    throw new ForbiddenException(
      `La bitácora de auditoría es inmutable: la operación ${params.action} no está permitida`,
    );
  }
  return next(params);
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super();
    this.$use(appendOnlyGuard);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
