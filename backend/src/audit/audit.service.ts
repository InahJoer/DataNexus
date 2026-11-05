import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import type { AuditEventInput, AuditEventType, AuditTransactionClient } from './audit.types.js';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto.js';

const CONNECTION_FIELDS = new Set(['tipoMotor', 'host', 'dbName', 'connectionString']);

export interface PaginatedAuditLogsResult {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  data: Array<{
    id: string;
    eventType: string;
    outcome: string;
    actorUserId: string | null;
    actorEmail: string | null;
    workspaceId: string | null;
    targetType: string | null;
    targetId: string | null;
    detailsJson: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
  }>;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditEventInput, tx?: AuditTransactionClient): Promise<void> {
    const client = tx ?? this.prisma;

    await client.$executeRaw`
      INSERT INTO "RegistroAuditoria" (
        "id", "eventType", "outcome", "actorUserId", "actorEmail", "workspaceId",
        "targetType", "targetId", "detailsJson", "ipAddress", "userAgent"
      ) VALUES (
        ${randomUUID()}, ${input.eventType}, ${input.outcome}, ${input.actorUserId ?? null},
        ${input.actorEmail ?? null}, ${input.workspaceId ?? null}, ${input.targetType ?? null},
        ${input.targetId ?? null}, ${this.serializeSafeDetails(input.eventType, input.details)},
        ${input.ipAddress?.slice(0, 128) ?? null}, ${input.userAgent?.slice(0, 512) ?? null}
      )
    `;
  }

  /**
   * Consulta paginada y filtrada de la bitácora de auditoría para el Workspace del actor.
   * Requiere rol ADMIN.
   */
  async findAll(
    actor: AuthenticatedUser,
    query: QueryAuditLogsDto,
  ): Promise<PaginatedAuditLogsResult> {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Se requiere rol ADMIN para consultar los logs de auditoría');
    }

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 50;
    const skip = (page - 1) * limit;

    const where: Prisma.RegistroAuditoriaWhereInput = {
      workspaceId: actor.workspaceId,
    };

    if (query.tipoAccion) {
      where.eventType = query.tipoAccion;
    }

    if (query.fechaInicio || query.fechaFin) {
      where.createdAt = {
        ...(query.fechaInicio ? { gte: new Date(query.fechaInicio) } : {}),
        ...(query.fechaFin ? { lte: new Date(query.fechaFin) } : {}),
      };
    }

    const [total, data] = await Promise.all([
      this.prisma.registroAuditoria.count({ where }),
      this.prisma.registroAuditoria.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data,
    };
  }

  private serializeSafeDetails(
    eventType: AuditEventType,
    details: Record<string, unknown> | undefined,
  ): string | null {
    if (!details) return null;

    const safeDetails: Record<string, unknown> = {};

    if (eventType === 'USER_ROLE_CHANGED') {
      for (const key of ['previousRole', 'newRole']) {
        if (typeof details[key] === 'string') safeDetails[key] = details[key];
      }
    }

    if (eventType === 'CONNECTION_CREATED' || eventType === 'CONNECTION_DELETED') {
      for (const key of ['tipoMotor', 'dbName']) {
        if (typeof details[key] === 'string') safeDetails[key] = details[key];
      }
    }

    if (eventType === 'CONNECTION_UPDATED' && Array.isArray(details.changedFields)) {
      const changedFields = details.changedFields.filter(
        (field): field is string => typeof field === 'string' && CONNECTION_FIELDS.has(field),
      );
      if (changedFields.length > 0) safeDetails.changedFields = [...new Set(changedFields)];
    }

    return Object.keys(safeDetails).length > 0 ? JSON.stringify(safeDetails) : null;
  }
}
