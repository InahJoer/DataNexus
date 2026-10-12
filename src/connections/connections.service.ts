import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from '../auth/interfaces/authenticated-user.interface.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../common/encryption/encryption.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateConnectionDto } from './dto/create-connection.dto.js';
import { UpdateConnectionDto } from './dto/update-connection.dto.js';

const SAFE_CONNECTION_SELECT = {
  id: true,
  tipoMotor: true,
  host: true,
  dbName: true,
  workspaceId: true,
} as const;

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    actor: AuthenticatedUser,
    input: CreateConnectionDto,
    context: RequestAuditContext = {},
  ) {
    this.assertAdmin(actor);

    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findUnique({ where: { id: actor.workspaceId } });
      if (!workspace) {
        throw new NotFoundException(`El Workspace con ID ${actor.workspaceId} no fue encontrado`);
      }

      const connection = await tx.conexionDB.create({
        data: {
          tipoMotor: input.tipoMotor,
          host: input.host,
          dbName: input.dbName,
          connectionStringEncriptada: this.encryptionService.encrypt(input.connectionString),
          workspaceId: actor.workspaceId,
        },
        select: SAFE_CONNECTION_SELECT,
      });

      await this.auditService.record(
        {
          eventType: 'CONNECTION_CREATED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'CONNECTION',
          targetId: connection.id,
          details: { tipoMotor: connection.tipoMotor, dbName: connection.dbName },
          ...context,
        },
        tx,
      );

      return connection;
    });
  }

  async findAll(actor: AuthenticatedUser) {
    return this.prisma.conexionDB.findMany({
      where: { workspaceId: actor.workspaceId },
      select: SAFE_CONNECTION_SELECT,
      orderBy: { id: 'desc' },
    });
  }

  async findOne(actor: AuthenticatedUser, id: string) {
    const connection = await this.prisma.conexionDB.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      select: SAFE_CONNECTION_SELECT,
    });

    if (!connection) throw new NotFoundException(`Conexión con ID ${id} no encontrada`);
    return connection;
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateConnectionDto,
    context: RequestAuditContext = {},
  ) {
    this.assertAdmin(actor);

    const changedFields = Object.keys(input).filter(
      (key) => input[key as keyof UpdateConnectionDto] !== undefined,
    );
    if (changedFields.length === 0) throw new BadRequestException('Debe indicar al menos un campo');

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.conexionDB.findFirst({
        where: { id, workspaceId: actor.workspaceId },
        select: {
          id: true,
          tipoMotor: true,
          host: true,
          dbName: true,
        },
      });

      if (!current) throw new NotFoundException(`Conexión con ID ${id} no encontrada`);

      const data: {
        tipoMotor?: string;
        host?: string;
        dbName?: string;
        connectionStringEncriptada?: string;
      } = {};
      if (input.tipoMotor !== undefined) data.tipoMotor = input.tipoMotor;
      if (input.host !== undefined) data.host = input.host;
      if (input.dbName !== undefined) data.dbName = input.dbName;
      if (input.connectionString !== undefined) {
        data.connectionStringEncriptada = this.encryptionService.encrypt(input.connectionString);
      }

      const connection = await tx.conexionDB.update({
        where: { id },
        data,
        select: SAFE_CONNECTION_SELECT,
      });

      await this.auditService.record(
        {
          eventType: 'CONNECTION_UPDATED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'CONNECTION',
          targetId: id,
          details: { changedFields },
          ...context,
        },
        tx,
      );

      return connection;
    });
  }

  async remove(actor: AuthenticatedUser, id: string, context: RequestAuditContext = {}) {
    this.assertAdmin(actor);

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.conexionDB.findFirst({
        where: { id, workspaceId: actor.workspaceId },
        select: { id: true, tipoMotor: true, dbName: true },
      });
      if (!current) throw new NotFoundException(`Conexión con ID ${id} no encontrada`);

      const connection = await tx.conexionDB.delete({
        where: { id },
        select: SAFE_CONNECTION_SELECT,
      });

      await this.auditService.record(
        {
          eventType: 'CONNECTION_DELETED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'CONNECTION',
          targetId: id,
          details: { tipoMotor: current.tipoMotor, dbName: current.dbName },
          ...context,
        },
        tx,
      );

      return connection;
    });
  }

  /** Internal credential access for trusted backend modules; never expose through an HTTP route. */
  async getConnectionForExploration(id: string, workspaceId: string) {
    const connection = await this.prisma.conexionDB.findFirst({
      where: { id, workspaceId },
      select: {
        id: true,
        tipoMotor: true,
        dbName: true,
        connectionStringEncriptada: true,
      },
    });

    if (!connection) throw new NotFoundException(`Conexión con ID ${id} no encontrada`);

    return {
      id: connection.id,
      tipoMotor: connection.tipoMotor,
      dbName: connection.dbName,
      connectionString: this.encryptionService.decrypt(connection.connectionStringEncriptada),
    };
  }

  private assertAdmin(actor: AuthenticatedUser): void {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Solo un ADMIN puede modificar conexiones');
    }
  }
}
