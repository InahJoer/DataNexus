import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface.js';
import type { CreateSensitiveFieldDto } from './sensitive-fields.dto.js';
import type { SensitiveRule } from './masking.service.js';

/** conexionId o entidad vacíos = la regla aplica a todas (no se usa NULL para que el índice único funcione). */
const ALL = '';

/** La API devuelve null en lugar de '' para el alcance "todas". */
function toResponse<T extends { conexionId: string; entidad: string }>(rule: T) {
  return { ...rule, conexionId: rule.conexionId || null, entidad: rule.entidad || null };
}

export interface SensitiveSource {
  conexionId: string;
  entidad: string;
}

/**
 * Campos sensibles configurables (RF-20, issue #34). El ADMIN marca campos por workspace, conexión y entidad; el
 * motor de datos los combina con las heurísticas de MaskingService en todos los endpoints que devuelven datos.
 */
@Injectable()
export class SensitiveFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthenticatedUser) {
    const rules = await this.prisma.sensitiveField.findMany({
      where: { workspaceId: actor.workspaceId },
      orderBy: [{ campo: 'asc' }, { createdAt: 'asc' }],
    });
    return rules.map(toResponse);
  }

  async create(actor: AuthenticatedUser, dto: CreateSensitiveFieldDto) {
    if (dto.conexionId) {
      const connection = await this.prisma.conexionDB.findFirst({
        where: { id: dto.conexionId, workspaceId: actor.workspaceId },
        select: { id: true },
      });
      if (!connection) throw new NotFoundException('Conexión no encontrada en el workspace');
    }
    try {
      const rule = await this.prisma.sensitiveField.create({
        data: {
          workspaceId: actor.workspaceId,
          conexionId: dto.conexionId ?? ALL,
          entidad: dto.entidad?.trim() || ALL,
          campo: dto.campo.trim().toLowerCase(),
          estrategia: dto.estrategia ?? 'FULL',
          creadoPor: actor.email,
        },
      });
      return toResponse(rule);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ese campo ya está marcado como sensible con el mismo alcance');
      }
      throw error;
    }
  }

  async remove(actor: AuthenticatedUser, id: string) {
    const { count } = await this.prisma.sensitiveField.deleteMany({ where: { id, workspaceId: actor.workspaceId } });
    if (count === 0) throw new NotFoundException('Campo sensible no encontrado');
  }

  /**
   * Reglas que aplican a una consulta: las del workspace sin alcance, las de cualquiera de sus conexiones y las de sus
   * entidades, más los `camposSensibles` por defecto del workspace (estrategia FULL). Si una entidad no coincide no
   * se aplica; en la duda (mismo nombre de campo en otra fuente del cruce) se enmascara de más, nunca de menos.
   */
  async rulesFor(workspaceId: string, sources: readonly SensitiveSource[]): Promise<SensitiveRule[]> {
    const connectionIds = [...new Set(sources.map((source) => source.conexionId))];
    const [configured, workspace] = await Promise.all([
      this.prisma.sensitiveField.findMany({
        where: { workspaceId, conexionId: { in: [ALL, ...connectionIds] } },
        select: { conexionId: true, entidad: true, campo: true, estrategia: true },
      }),
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { camposSensibles: true } }),
    ]);

    const applies = (rule: { conexionId: string; entidad: string }) =>
      sources.some(
        (source) =>
          (rule.conexionId === ALL || rule.conexionId === source.conexionId) &&
          (rule.entidad === ALL || rule.entidad.toLowerCase() === source.entidad.toLowerCase()),
      );
    const rules: SensitiveRule[] = configured
      .filter(applies)
      .map((rule) => ({ campo: rule.campo.toLowerCase(), estrategia: rule.estrategia }));
    for (const campo of workspace?.camposSensibles ?? []) {
      if (!rules.some((rule) => rule.campo === campo.toLowerCase())) rules.push({ campo: campo.toLowerCase(), estrategia: 'FULL' });
    }
    return rules;
  }
}
