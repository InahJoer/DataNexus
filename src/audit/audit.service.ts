import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuditEventInput, AuditEventType, AuditTransactionClient } from './audit.types.js';

const CONNECTION_FIELDS = new Set(['tipoMotor', 'host', 'dbName', 'connectionString']);

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
