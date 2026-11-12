import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { PersonalAccessToken } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthenticatedUser, RequestAuditContext } from '../interfaces/authenticated-user.interface.js';
import { isUserRole } from '../interfaces/user-role.js';
import {
  PAT_DEFAULT_EXPIRATION_DAYS,
  type CreatePersonalAccessTokenDto,
  type CreatedPersonalAccessTokenDto,
  type PatScopeDto,
  type PersonalAccessTokenDto,
} from './dto/personal-access-token.dto.js';
import { PAT_PREFIX, PAT_SCOPE_DESCRIPTIONS, PAT_SCOPE_NAMES, permissionsOfScopes, roleCanGrantScope, type PatScope } from './pat-scopes.js';

/** Tokens activos por usuario. */
export const PAT_MAX_ACTIVE_PER_USER = 20;
/** lastUsedAt se actualiza como máximo una vez por minuto y PAT_USED se audita una vez por hora, para no escribir en cada petición. */
const LAST_USED_RESOLUTION_MS = 60_000;
const USAGE_AUDIT_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export const PAT_INVALID_MESSAGE = 'Token de acceso personal inválido, caducado o revocado';

export const hashPersonalAccessToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

const newToken = (): string => `${PAT_PREFIX}${randomBytes(32).toString('base64url')}`;

/** Tokens de acceso personal para integraciones (issue #65). */
@Injectable()
export class PersonalAccessTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Catálogo de alcances, marcando los que el rol del usuario puede conceder. */
  scopes(actor: AuthenticatedUser): PatScopeDto[] {
    return PAT_SCOPE_NAMES.map((permiso) => ({
      permiso,
      descripcion: PAT_SCOPE_DESCRIPTIONS[permiso],
      disponible: roleCanGrantScope(actor.role, permiso),
    }));
  }

  async list(actor: AuthenticatedUser): Promise<PersonalAccessTokenDto[]> {
    const tokens = await this.prisma.personalAccessToken.findMany({
      where: { userId: actor.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return tokens.map((token) => this.toDto(token));
  }

  async create(actor: AuthenticatedUser, dto: CreatePersonalAccessTokenDto, context: RequestAuditContext = {}): Promise<CreatedPersonalAccessTokenDto> {
    this.assertScopesAllowed(actor, dto.permisos);
    const active = await this.prisma.personalAccessToken.count({
      where: { userId: actor.id, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (active >= PAT_MAX_ACTIVE_PER_USER) {
      throw new ConflictException(`Ya tienes ${PAT_MAX_ACTIVE_PER_USER} tokens activos. Revoca alguno antes de crear otro.`);
    }

    const days = dto.expiraEnDias ?? PAT_DEFAULT_EXPIRATION_DAYS;
    const { record, token } = await this.issue(actor, {
      nombre: dto.nombre.trim(),
      permisos: dto.permisos,
      expiresAt: new Date(Date.now() + days * DAY_MS),
    });
    await this.audit.record({
      eventType: 'PAT_CREATED',
      outcome: 'SUCCESS',
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'PERSONAL_ACCESS_TOKEN',
      targetId: record.id,
      details: { nombre: record.nombre, prefijo: record.prefijo, permisos: record.permisos, diasValidez: days },
      ...context,
    });
    return Object.assign(this.toDto(record), { token });
  }

  /**
   * Revoca el token y emite otro con el mismo nombre, alcances y duración.
   * Los alcances que el rol actual ya no permite se descartan.
   */
  async rotate(actor: AuthenticatedUser, id: string, context: RequestAuditContext = {}): Promise<CreatedPersonalAccessTokenDto> {
    const current = await this.findOwned(actor, id);
    const permisos = current.permisos.filter((scope) => roleCanGrantScope(actor.role, scope as PatScope));
    if (permisos.length === 0) throw new BadRequestException('Tu rol actual ya no permite ninguno de los permisos de este token');

    const duration = Math.max(current.expiresAt.getTime() - current.createdAt.getTime(), DAY_MS);
    const { record, token } = await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.personalAccessToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count === 0) throw new NotFoundException('Token no encontrado');
      return this.issue(actor, { nombre: current.nombre, permisos, expiresAt: new Date(Date.now() + duration), rotatedFromId: current.id }, tx);
    });
    await this.audit.record({
      eventType: 'PAT_ROTATED',
      outcome: 'SUCCESS',
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'PERSONAL_ACCESS_TOKEN',
      targetId: record.id,
      details: { anterior: current.id, nombre: record.nombre, prefijo: record.prefijo, permisos: record.permisos },
      ...context,
    });
    return Object.assign(this.toDto(record), { token });
  }

  async revoke(actor: AuthenticatedUser, id: string, context: RequestAuditContext = {}): Promise<void> {
    const result = await this.prisma.personalAccessToken.updateMany({
      where: { id, userId: actor.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Token no encontrado');
    await this.audit.record({
      eventType: 'PAT_REVOKED',
      outcome: 'SUCCESS',
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'PERSONAL_ACCESS_TOKEN',
      targetId: id,
      ...context,
    });
  }

  /**
   * Autentica una petición con `Authorization: Bearer pat_...`. Lanza 401 si el token no existe,
   * está revocado o caducado, o su dueño ya no tiene un rol válido.
   */
  async authenticate(token: string, context: RequestAuditContext = {}): Promise<AuthenticatedUser> {
    const record = await this.prisma.personalAccessToken.findUnique({
      where: { tokenHash: hashPersonalAccessToken(token) },
      include: { user: { select: { id: true, email: true, name: true, role: true, workspaceId: true } } },
    });
    const now = new Date();
    if (!record || record.revokedAt || record.expiresAt <= now || !isUserRole(record.user.role) || record.user.workspaceId !== record.workspaceId) {
      throw new UnauthorizedException(PAT_INVALID_MESSAGE);
    }

    await this.touch(record, now, context);
    return {
      id: record.user.id,
      email: record.user.email,
      name: record.user.name,
      role: record.user.role,
      workspaceId: record.user.workspaceId,
      authMethod: 'pat',
      tokenId: record.id,
      tokenPermissions: permissionsOfScopes(record.permisos),
    };
  }

  private async touch(record: PersonalAccessToken & { user: { email: string } }, now: Date, context: RequestAuditContext): Promise<void> {
    const last = record.lastUsedAt?.getTime() ?? 0;
    if (now.getTime() - last < LAST_USED_RESOLUTION_MS) return;
    await this.prisma.personalAccessToken.update({
      where: { id: record.id },
      data: { lastUsedAt: now, lastUsedIp: context.ipAddress ?? null },
    });
    if (now.getTime() - last >= USAGE_AUDIT_INTERVAL_MS) {
      await this.audit.record({
        eventType: 'PAT_USED',
        outcome: 'SUCCESS',
        actorUserId: record.userId,
        actorEmail: record.user.email,
        workspaceId: record.workspaceId,
        targetType: 'PERSONAL_ACCESS_TOKEN',
        targetId: record.id,
        details: { nombre: record.nombre, prefijo: record.prefijo },
        ...context,
      });
    }
  }

  private assertScopesAllowed(actor: AuthenticatedUser, scopes: readonly PatScope[]): void {
    const denied = scopes.filter((scope) => !roleCanGrantScope(actor.role, scope));
    if (denied.length > 0) {
      throw new BadRequestException(`Tu rol no puede conceder: ${denied.join(', ')}. Un token nunca da más permisos que el rol de su dueño.`);
    }
  }

  private async findOwned(actor: AuthenticatedUser, id: string): Promise<PersonalAccessToken> {
    const token = await this.prisma.personalAccessToken.findFirst({ where: { id, userId: actor.id, revokedAt: null } });
    if (!token) throw new NotFoundException('Token no encontrado');
    return token;
  }

  private async issue(
    actor: AuthenticatedUser,
    data: { nombre: string; permisos: string[]; expiresAt: Date; rotatedFromId?: string },
    client: Pick<PrismaService, 'personalAccessToken'> = this.prisma,
  ): Promise<{ record: PersonalAccessToken; token: string }> {
    const token = newToken();
    const record = await client.personalAccessToken.create({
      data: {
        ...data,
        tokenHash: hashPersonalAccessToken(token),
        prefijo: token.slice(0, PAT_PREFIX.length + 8),
        userId: actor.id,
        workspaceId: actor.workspaceId,
      },
    });
    return { record, token };
  }

  private toDto(token: PersonalAccessToken): PersonalAccessTokenDto {
    return {
      id: token.id,
      nombre: token.nombre,
      prefijo: token.prefijo,
      permisos: token.permisos,
      estado: token.expiresAt > new Date() ? 'ACTIVO' : 'CADUCADO',
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      createdAt: token.createdAt,
    };
  }
}
