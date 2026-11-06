import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
import { DataEngineService } from '../data-engine/data-engine.service.js';
import { CrossJoinDto } from '../data-engine/dto/cross-join.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateSavedQueryDto,
  ListSavedQueriesQueryDto,
  RunSavedQueryDto,
  SavedQueryResponseDto,
  SavedQueryRunResultDto,
  SavedQueryVersionDto,
  SavedQueryVisibility,
  UpdateSavedQueryDto,
} from './dto/saved-query.dto.js';

/** Campos de paginación: se deciden en cada ejecución y no forman parte de la definición guardada. */
const PAGINATION_KEYS = ['limit', 'offset'] as const;

const AUTHOR_SELECT = { select: { id: true, name: true } } as const;

const SAVED_QUERY_SELECT = {
  id: true,
  workspaceId: true,
  nombre: true,
  descripcion: true,
  definicion: true,
  version: true,
  visibilidad: true,
  autorId: true,
  autor: AUTHOR_SELECT,
  createdAt: true,
  updatedAt: true,
} as const;

type SavedQueryRecord = Prisma.SavedQueryGetPayload<{ select: typeof SAVED_QUERY_SELECT }>;

/** Definición tal como se persiste: el cuerpo de POST /engine/join sin limit ni offset. */
export type StoredDefinition = Record<string, unknown>;

export interface PreparedSavedQueryRun {
  /** Payload exacto que recibirá el motor; el controlador lo usa también para la bitácora. */
  payload: CrossJoinDto;
  query: { id: string; nombre: string };
  version: number;
}

/** Convierte la definición validada en JSON plano, sin paginación. */
export function toStoredDefinition(definition: CrossJoinDto): StoredDefinition {
  const plain = JSON.parse(JSON.stringify(definition)) as StoredDefinition;
  for (const key of PAGINATION_KEYS) delete plain[key];
  return plain;
}

/** JSON con las claves ordenadas, para saber si una definición cambió de verdad. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function connectionIdsOf(definition: StoredDefinition): string[] {
  const ids = new Set<string>();
  const sources = definition.fuentes;
  if (Array.isArray(sources)) {
    for (const source of sources) {
      const id = (source as { conexionId?: unknown }).conexionId;
      if (typeof id === 'string') ids.add(id);
    }
  }
  for (const key of ['conexionSqlId', 'conexionNoSqlId']) {
    if (typeof definition[key] === 'string') ids.add(definition[key] as string);
  }
  return [...ids];
}

/**
 * Consultas guardadas del Query Builder (UC4/UC7, issue #35): el OPERADOR construye vistas
 * unificadas y el LECTOR consume las publicadas. Ejecutar una consulta guardada pasa por
 * DataEngineService.executeCrossJoin, igual que POST /engine/join, así que hereda los mismos
 * límites, filtros y enmascaramiento por rol.
 */
@Injectable()
export class SavedQueriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataEngine: DataEngineService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    actor: AuthenticatedUser,
    input: CreateSavedQueryDto,
    context: RequestAuditContext = {},
  ): Promise<SavedQueryResponseDto> {
    this.assertCanManage(actor);
    const definicion = toStoredDefinition(input.definicion);
    await this.assertConnectionsInWorkspace(actor, definicion);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const query = await tx.savedQuery.create({
          data: {
            workspaceId: actor.workspaceId,
            nombre: input.nombre.trim(),
            descripcion: input.descripcion?.trim() || null,
            definicion: definicion as Prisma.InputJsonValue,
            visibilidad: input.visibilidad ?? 'PRIVADA',
            autorId: actor.id,
            versiones: {
              create: { version: 1, definicion: definicion as Prisma.InputJsonValue, autorId: actor.id },
            },
          },
          select: SAVED_QUERY_SELECT,
        });

        await this.auditService.record(
          {
            eventType: 'SAVED_QUERY_CREATED',
            outcome: 'SUCCESS',
            actorUserId: actor.id,
            actorEmail: actor.email,
            workspaceId: actor.workspaceId,
            targetType: 'SAVED_QUERY',
            targetId: query.id,
            details: { nombre: query.nombre, visibilidad: query.visibilidad, version: 1 },
            ...context,
          },
          tx,
        );
        return query;
      });
      return this.toResponse(created, actor);
    } catch (error) {
      throw this.translateUniqueName(error);
    }
  }

  async findAll(
    actor: AuthenticatedUser,
    filters: ListSavedQueriesQueryDto = {},
  ): Promise<SavedQueryResponseDto[]> {
    const where: Prisma.SavedQueryWhereInput = { workspaceId: actor.workspaceId };
    if (!this.canSeeDrafts(actor)) {
      where.visibilidad = 'PUBLICADA';
    } else if (filters.visibilidad) {
      where.visibilidad = filters.visibilidad;
    }

    const queries = await this.prisma.savedQuery.findMany({
      where,
      select: SAVED_QUERY_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
    return queries.map((query) => this.toResponse(query, actor));
  }

  async findOne(actor: AuthenticatedUser, id: string): Promise<SavedQueryResponseDto> {
    return this.toResponse(await this.findVisible(actor, id), actor);
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateSavedQueryDto,
    context: RequestAuditContext = {},
  ): Promise<SavedQueryResponseDto> {
    this.assertCanManage(actor);
    const current = await this.findVisible(actor, id);
    this.assertCanEdit(actor, current);

    const data: Prisma.SavedQueryUpdateInput = {};
    const changedFields: string[] = [];
    if (input.nombre !== undefined && input.nombre.trim() !== current.nombre) {
      data.nombre = input.nombre.trim();
      changedFields.push('nombre');
    }
    if (input.descripcion !== undefined && (input.descripcion.trim() || null) !== current.descripcion) {
      data.descripcion = input.descripcion.trim() || null;
      changedFields.push('descripcion');
    }
    if (input.visibilidad !== undefined && input.visibilidad !== current.visibilidad) {
      data.visibilidad = input.visibilidad;
      changedFields.push('visibilidad');
    }

    let nextDefinition: StoredDefinition | undefined;
    if (input.definicion !== undefined) {
      const definicion = toStoredDefinition(input.definicion);
      if (stableStringify(definicion) !== stableStringify(current.definicion)) {
        await this.assertConnectionsInWorkspace(actor, definicion);
        nextDefinition = definicion;
        changedFields.push('definicion');
      }
    }

    if (changedFields.length === 0) return this.toResponse(current, actor);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        let version = current.version;
        if (nextDefinition) {
          // Versionado simple: cada cambio real de la definición crea una versión nueva.
          version = current.version + 1;
          data.definicion = nextDefinition as Prisma.InputJsonValue;
          data.version = version;
          await tx.savedQueryVersion.create({
            data: {
              savedQueryId: id,
              version,
              definicion: nextDefinition as Prisma.InputJsonValue,
              autorId: actor.id,
            },
          });
        }

        const query = await tx.savedQuery.update({ where: { id }, data, select: SAVED_QUERY_SELECT });
        await this.auditService.record(
          {
            eventType: 'SAVED_QUERY_UPDATED',
            outcome: 'SUCCESS',
            actorUserId: actor.id,
            actorEmail: actor.email,
            workspaceId: actor.workspaceId,
            targetType: 'SAVED_QUERY',
            targetId: id,
            details: { changedFields, version },
            ...context,
          },
          tx,
        );
        return query;
      });
      return this.toResponse(updated, actor);
    } catch (error) {
      throw this.translateUniqueName(error);
    }
  }

  async remove(
    actor: AuthenticatedUser,
    id: string,
    context: RequestAuditContext = {},
  ): Promise<{ id: string; nombre: string }> {
    this.assertCanManage(actor);
    const current = await this.findVisible(actor, id);
    this.assertCanEdit(actor, current);

    await this.prisma.$transaction(async (tx) => {
      await tx.savedQuery.delete({ where: { id } });
      await this.auditService.record(
        {
          eventType: 'SAVED_QUERY_DELETED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'SAVED_QUERY',
          targetId: id,
          details: { nombre: current.nombre, version: current.version },
          ...context,
        },
        tx,
      );
    });
    return { id, nombre: current.nombre };
  }

  async listVersions(actor: AuthenticatedUser, id: string): Promise<SavedQueryVersionDto[]> {
    this.assertCanManage(actor);
    await this.findVisible(actor, id);
    const versions = await this.prisma.savedQueryVersion.findMany({
      where: { savedQueryId: id },
      select: { version: true, definicion: true, createdAt: true, autor: AUTHOR_SELECT },
      orderBy: { version: 'desc' },
    });
    return versions.map((version) => ({
      version: version.version,
      definicion: version.definicion as StoredDefinition,
      autor: version.autor,
      createdAt: version.createdAt,
    }));
  }

  /**
   * Ejecuta la consulta con el mismo motor que POST /engine/join. El LECTOR solo llega aquí
   * con consultas publicadas y recibe los datos enmascarados según su rol.
   */
  async run(
    actor: AuthenticatedUser,
    id: string,
    options: RunSavedQueryDto = {},
  ): Promise<SavedQueryRunResultDto> {
    return this.execute(actor, await this.prepareRun(actor, id, options));
  }

  /** Resuelve la versión, reconstruye el payload del join y lo valida, sin tocar las fuentes. */
  async prepareRun(
    actor: AuthenticatedUser,
    id: string,
    options: RunSavedQueryDto = {},
  ): Promise<PreparedSavedQueryRun> {
    const query = await this.findVisible(actor, id);

    let definition = query.definicion as StoredDefinition;
    let version = query.version;
    if (options.version !== undefined && options.version !== query.version) {
      this.assertCanManage(actor);
      const snapshot = await this.prisma.savedQueryVersion.findUnique({
        where: { savedQueryId_version: { savedQueryId: id, version: options.version } },
        select: { definicion: true },
      });
      if (!snapshot) throw new NotFoundException(`La consulta no tiene versión ${options.version}`);
      definition = snapshot.definicion as StoredDefinition;
      version = options.version;
    }

    return {
      payload: await this.toJoinPayload(definition, options),
      query: { id: query.id, nombre: query.nombre },
      version,
    };
  }

  async execute(actor: AuthenticatedUser, prepared: PreparedSavedQueryRun): Promise<SavedQueryRunResultDto> {
    const page = await this.dataEngine.executeCrossJoin(prepared.payload, actor);
    return { ...page, consultaId: prepared.query.id, version: prepared.version };
  }

  /** Reconstruye y revalida el DTO del join: una definición antigua puede no cumplir reglas nuevas. */
  private async toJoinPayload(
    definition: StoredDefinition,
    options: RunSavedQueryDto,
  ): Promise<CrossJoinDto> {
    const plain: Record<string, unknown> = { ...definition };
    for (const key of PAGINATION_KEYS) delete plain[key];
    if (options.limit !== undefined) plain.limit = options.limit;
    if (options.offset !== undefined) plain.offset = options.offset;

    const payload = plainToInstance(CrossJoinDto, plain);
    const errors = await validate(payload, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length > 0) {
      throw new UnprocessableEntityException(
        'La definición guardada ya no es válida para el motor actual. Edite la consulta y guárdela de nuevo.',
      );
    }
    return payload;
  }

  private async findVisible(actor: AuthenticatedUser, id: string): Promise<SavedQueryRecord> {
    const query = await this.prisma.savedQuery.findFirst({
      where: {
        id,
        workspaceId: actor.workspaceId,
        ...(this.canSeeDrafts(actor) ? {} : { visibilidad: 'PUBLICADA' as const }),
      },
      select: SAVED_QUERY_SELECT,
    });
    // Una consulta privada responde 404 al LECTOR para no revelar que existe.
    if (!query) throw new NotFoundException(`Consulta guardada con ID ${id} no encontrada`);
    return query;
  }

  /** Impide guardar referencias a conexiones de otro workspace o eliminadas. */
  private async assertConnectionsInWorkspace(
    actor: AuthenticatedUser,
    definition: StoredDefinition,
  ): Promise<void> {
    const ids = connectionIdsOf(definition);
    if (ids.length === 0) return;
    const found = await this.prisma.conexionDB.count({
      where: { id: { in: ids }, workspaceId: actor.workspaceId },
    });
    if (found !== ids.length) {
      throw new NotFoundException('Alguna de las conexiones de la consulta no existe en el workspace');
    }
  }

  private canSeeDrafts(actor: AuthenticatedUser): boolean {
    return hasPermission(actor.role, 'MANAGE_QUERIES');
  }

  private assertCanManage(actor: AuthenticatedUser): void {
    if (!hasPermission(actor.role, 'MANAGE_QUERIES')) {
      throw new ForbiddenException('Solo ADMIN u OPERADOR pueden gestionar consultas guardadas');
    }
  }

  /** El OPERADOR solo modifica sus propias consultas; el ADMIN, cualquiera del workspace. */
  private assertCanEdit(actor: AuthenticatedUser, query: SavedQueryRecord): void {
    if (actor.role !== 'ADMIN' && query.autorId !== actor.id) {
      throw new ForbiddenException('Solo el autor o un ADMIN puede modificar esta consulta');
    }
  }

  private toResponse(query: SavedQueryRecord, actor: AuthenticatedUser): SavedQueryResponseDto {
    return {
      id: query.id,
      nombre: query.nombre,
      descripcion: query.descripcion,
      // El LECTOR consume el resultado; la definición (conexiones, filtros) es del constructor de la vista.
      definicion: this.canSeeDrafts(actor) ? (query.definicion as StoredDefinition) : null,
      version: query.version,
      visibilidad: query.visibilidad as SavedQueryVisibility,
      autor: query.autor,
      createdAt: query.createdAt,
      updatedAt: query.updatedAt,
    };
  }

  private translateUniqueName(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException('Ya existe una consulta guardada con ese nombre en el workspace');
    }
    return error;
  }
}
