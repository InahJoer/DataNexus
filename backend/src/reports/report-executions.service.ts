import { Injectable } from '@nestjs/common';
import type { Prisma, ReportExecution } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  ListReportExecutionsQueryDto,
  ReportExecutionResponseDto,
} from './dto/scheduled-report.dto.js';

const DEFAULT_PAGE_SIZE = 50;

/** Consulta del historial de ejecuciones de reportes (issue #39). Siempre filtra por workspace. */
@Injectable()
export class ReportExecutionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    workspaceId: string,
    filters: ListReportExecutionsQueryDto & { scheduledReportId?: string } = {},
  ): Promise<ReportExecutionResponseDto[]> {
    const where: Prisma.ReportExecutionWhereInput = { workspaceId };
    if (filters.scheduledReportId) where.scheduledReportId = filters.scheduledReportId;
    if (filters.status) where.status = filters.status;
    if (filters.trigger) where.trigger = filters.trigger;

    const executions = await this.prisma.reportExecution.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: filters.limit ?? DEFAULT_PAGE_SIZE,
    });
    return executions.map((execution) => toReportExecutionResponse(execution));
  }
}

/** Respuesta pública: sin lease ni clave de idempotencia; el enlace solo mientras siga vigente. */
export function toReportExecutionResponse(
  execution: ReportExecution,
  now: Date = new Date(),
): ReportExecutionResponseDto {
  return {
    id: execution.id,
    scheduledReportId: execution.scheduledReportId,
    trigger: execution.trigger,
    status: execution.status,
    titulo: execution.titulo,
    formato: execution.formato,
    scheduledFor: execution.scheduledFor,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    durationMs: execution.durationMs,
    attempts: execution.attempts,
    totalRows: execution.totalRows,
    fileSizeBytes: execution.fileSizeBytes,
    error: execution.error,
    downloadUrl: execution.expiresAt && execution.expiresAt > now ? execution.downloadUrl : null,
    expiresAt: execution.expiresAt,
    messageId: execution.messageId,
    authorNotifiedAt: execution.authorNotifiedAt,
  };
}
