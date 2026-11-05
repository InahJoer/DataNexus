import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { appendOnlyGuard } from './prisma.service.js';

const params = (model: string, action: string) =>
  ({ model, action, args: {}, dataPath: [], runInTransaction: false }) as unknown as Prisma.MiddlewareParams;

describe('appendOnlyGuard (bitácora inmutable)', () => {
  it.each(['update', 'updateMany', 'upsert', 'delete', 'deleteMany'])(
    'bloquea %s sobre RegistroAuditoria sin llegar a la base de datos',
    async (action) => {
      const next = vi.fn();
      await expect(async () => appendOnlyGuard(params('RegistroAuditoria', action), next)).rejects.toThrow(
        ForbiddenException,
      );
      expect(next).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'findMany', 'count', 'findUnique'])('permite %s sobre RegistroAuditoria', async (action) => {
    const next = vi.fn().mockResolvedValue('ok');
    await expect(appendOnlyGuard(params('RegistroAuditoria', action), next)).resolves.toBe('ok');
  });

  it('no afecta a otros modelos', async () => {
    const next = vi.fn().mockResolvedValue('ok');
    await expect(appendOnlyGuard(params('User', 'delete'), next)).resolves.toBe('ok');
  });
});
