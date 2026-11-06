import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  AuthenticatedUser,
  RequestAuditContext,
} from '../auth/interfaces/authenticated-user.interface.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../common/encryption/encryption.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateConnectionDto } from './dto/create-connection.dto.js';
import { UpdateConnectionDto } from './dto/update-connection.dto.js';
import type { ConnectionResponseDto } from './dto/connection-response.dto.js';
import type { FirestoreUploadFieldsDto, UploadedServiceAccountFile } from './dto/firestore-connection.dto.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
import type { TipoMotor } from '../common/tipo-motor.js';
import {
  FIRESTORE_DEFAULT_DATABASE,
  STRUCTURED_CREDENTIALS_VERSION,
  describeCredentials,
  parseServiceAccountFile,
  parseStoredCredentials,
  serializeCredentials,
  toDriverConnectionString,
  validateCredentials,
  type ConnectionCredentials,
  type FirestoreCredentials,
} from './credentials/connection-credentials.js';

const SAFE_CONNECTION_SELECT = {
  id: true,
  nombre: true,
  tipoMotor: true,
  host: true,
  dbName: true,
  workspaceId: true,
  credencialesVersion: true,
  detalles: true,
} as const satisfies Prisma.ConexionDBSelect;

type SafeConnectionRow = Prisma.ConexionDBGetPayload<{ select: typeof SAFE_CONNECTION_SELECT }>;

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly auditService: AuditService,
  ) {}

  /** Alta con credenciales estructuradas por motor (RF-08). */
  async create(actor: AuthenticatedUser, input: CreateConnectionDto, context: RequestAuditContext = {}) {
    this.assertAdmin(actor);
    const credentials = await validateCredentials(input.tipoMotor, input.credenciales);
    return this.persistNew(actor, input.nombre, input.tipoMotor, credentials, context);
  }

  /** Alta de Firestore subiendo el JSON de Service Account (RF-09). El archivo se procesa en memoria. */
  async createFirestoreFromUpload(
    actor: AuthenticatedUser,
    file: UploadedServiceAccountFile | undefined,
    fields: FirestoreUploadFieldsDto,
    context: RequestAuditContext = {},
  ) {
    this.assertAdmin(actor);
    const credentials: FirestoreCredentials = {
      serviceAccount: parseServiceAccountFile(this.readUploadedFile(file)),
      databaseId: fields.databaseId ?? FIRESTORE_DEFAULT_DATABASE,
    };
    return this.persistNew(actor, fields.nombre, 'FIRESTORE', credentials, context);
  }

  async findAll(actor: AuthenticatedUser): Promise<ConnectionResponseDto[]> {
    const connections = await this.prisma.conexionDB.findMany({
      where: { workspaceId: actor.workspaceId },
      select: SAFE_CONNECTION_SELECT,
      orderBy: { id: 'desc' },
    });
    return connections.map((connection) => this.toResponse(connection));
  }

  async findOne(actor: AuthenticatedUser, id: string): Promise<ConnectionResponseDto> {
    const connection = await this.prisma.conexionDB.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      select: SAFE_CONNECTION_SELECT,
    });

    if (!connection) throw new NotFoundException(`Conexión con ID ${id} no encontrada`);
    return this.toResponse(connection);
  }

  /**
   * Cambio parcial. Con el mismo motor y credenciales estructuradas, `credenciales` se fusiona con las
   * guardadas (p. ej. rotar solo la contraseña). Cambiar de motor exige credenciales completas.
   */
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
        select: { id: true, tipoMotor: true, connectionStringEncriptada: true },
      });
      if (!current) throw new NotFoundException(`Conexión con ID ${id} no encontrada`);

      const currentEngine = current.tipoMotor as TipoMotor;
      const targetEngine = input.tipoMotor ?? currentEngine;
      if (targetEngine !== currentEngine && input.credenciales === undefined) {
        throw new BadRequestException('Para cambiar el tipo de motor envía también las credenciales completas');
      }

      const data: Prisma.ConexionDBUpdateInput = {};
      if (input.nombre !== undefined) data.nombre = input.nombre;
      if (input.credenciales !== undefined) {
        const stored =
          targetEngine === currentEngine
            ? parseStoredCredentials(this.encryptionService.decrypt(current.connectionStringEncriptada))
            : null;
        const merged =
          stored && stored.tipoMotor === targetEngine
            ? { ...(stored.credentials as object), ...input.credenciales }
            : input.credenciales;
        const credentials = await validateCredentials(targetEngine, merged);
        Object.assign(data, this.credentialColumns(targetEngine, credentials));
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

      return this.toResponse(connection);
    });
  }

  /** Sustituye el Service Account de una conexión Firestore (rotación de claves). */
  async replaceServiceAccount(
    actor: AuthenticatedUser,
    id: string,
    file: UploadedServiceAccountFile | undefined,
    fields: FirestoreUploadFieldsDto,
    context: RequestAuditContext = {},
  ) {
    this.assertAdmin(actor);
    const serviceAccount = parseServiceAccountFile(this.readUploadedFile(file));

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.conexionDB.findFirst({
        where: { id, workspaceId: actor.workspaceId },
        select: { id: true, tipoMotor: true, dbName: true },
      });
      if (!current) throw new NotFoundException(`Conexión con ID ${id} no encontrada`);
      if (current.tipoMotor !== 'FIRESTORE') {
        throw new BadRequestException('Solo las conexiones Firestore usan un Service Account');
      }

      const credentials: FirestoreCredentials = {
        serviceAccount,
        databaseId: fields.databaseId ?? (current.dbName || FIRESTORE_DEFAULT_DATABASE),
      };
      const data: Prisma.ConexionDBUpdateInput = this.credentialColumns('FIRESTORE', credentials);
      if (fields.nombre !== undefined) data.nombre = fields.nombre;

      const connection = await tx.conexionDB.update({ where: { id }, data, select: SAFE_CONNECTION_SELECT });

      await this.auditService.record(
        {
          eventType: 'CONNECTION_UPDATED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'CONNECTION',
          targetId: id,
          details: { changedFields: fields.nombre !== undefined ? ['credenciales', 'nombre'] : ['credenciales'] },
          ...context,
        },
        tx,
      );

      return this.toResponse(connection);
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

      return this.toResponse(connection);
    });
  }

  /**
   * Acceso interno a credenciales para módulos de confianza; nunca exponer por HTTP.
   * Devuelve la cadena en el formato del driver, tanto para credenciales estructuradas como legado.
   */
  async getConnectionForExploration(id: string, workspaceId: string) {
    const connection = await this.findConnectionForInternalUse(id, workspaceId);

    return {
      id: connection.id,
      tipoMotor: connection.tipoMotor,
      dbName: connection.dbName,
      connectionString: toDriverConnectionString(
        this.encryptionService.decrypt(connection.connectionStringEncriptada),
      ),
    };
  }

  /** Credenciales cifradas para adaptadores que descifran por su cuenta (usan toDriverConnectionString). */
  async getConnectionForExtraction(id: string, workspaceId: string) {
    const connection = await this.findConnectionForInternalUse(id, workspaceId);

    return {
      id: connection.id,
      tipoMotor: connection.tipoMotor,
      dbName: connection.dbName,
      encryptedConnectionString: connection.connectionStringEncriptada,
    };
  }

  private async persistNew(
    actor: AuthenticatedUser,
    nombre: string | undefined,
    tipoMotor: TipoMotor,
    credentials: ConnectionCredentials,
    context: RequestAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findUnique({ where: { id: actor.workspaceId }, select: { id: true } });
      if (!workspace) {
        throw new NotFoundException(`El Workspace con ID ${actor.workspaceId} no fue encontrado`);
      }

      const connection = await tx.conexionDB.create({
        data: {
          nombre: nombre ?? null,
          workspaceId: actor.workspaceId,
          ...this.credentialColumns(tipoMotor, credentials),
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

      return this.toResponse(connection);
    });
  }

  /** Columnas derivadas de las credenciales: el payload completo va cifrado; host, dbName y detalles en claro. */
  private credentialColumns(tipoMotor: TipoMotor, credentials: ConnectionCredentials) {
    const metadata = describeCredentials(tipoMotor, credentials);
    return {
      tipoMotor,
      host: metadata.host,
      dbName: metadata.dbName,
      detalles: metadata.detalles,
      credencialesVersion: STRUCTURED_CREDENTIALS_VERSION,
      connectionStringEncriptada: this.encryptionService.encrypt(serializeCredentials(tipoMotor, credentials)),
    };
  }

  /** Exige un archivo procesado en memoria (multer sin almacenamiento en disco). */
  private readUploadedFile(file: UploadedServiceAccountFile | undefined): Buffer {
    if (!file) throw new BadRequestException('Adjunta el archivo JSON del Service Account en el campo serviceAccount');
    if (file.path || !file.buffer) {
      throw new BadRequestException('El archivo debe procesarse en memoria');
    }
    return file.buffer;
  }

  private toResponse(connection: SafeConnectionRow): ConnectionResponseDto {
    return {
      id: connection.id,
      nombre: connection.nombre,
      tipoMotor: connection.tipoMotor as TipoMotor,
      host: connection.host,
      dbName: connection.dbName,
      workspaceId: connection.workspaceId,
      formatoCredenciales:
        connection.credencialesVersion >= STRUCTURED_CREDENTIALS_VERSION ? 'ESTRUCTURADO' : 'LEGADO',
      detalles: (connection.detalles as Record<string, string | number | boolean> | null) ?? null,
    };
  }

  private async findConnectionForInternalUse(id: string, workspaceId: string) {
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
    return connection;
  }

  private assertAdmin(actor: AuthenticatedUser): void {
    if (!hasPermission(actor.role, 'MANAGE_CONNECTIONS')) {
      throw new ForbiddenException('Solo un ADMIN puede modificar conexiones');
    }
  }
}
