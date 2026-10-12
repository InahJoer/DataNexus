import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../common/encryption/encryption.service.js';
import { CreateConnectionDto } from './dto/create-connection.dto.js';
import { UpdateConnectionDto } from './dto/update-connection.dto.js';

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * Crea una nueva conexión encriptando la cadena de conexión con AES-256 (RNF-01).
   * @param createConnectionDto Datos de la conexión en texto plano
   */
  async create(createConnectionDto: CreateConnectionDto) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: createConnectionDto.workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException(
        `El Workspace con ID ${createConnectionDto.workspaceId} no fue encontrado`,
      );
    }

    // Encriptación AES-256 de las credenciales
    const connectionStringEncriptada = this.encryptionService.encrypt(
      createConnectionDto.connectionString,
    );

    return this.prisma.conexionDB.create({
      data: {
        tipoMotor: createConnectionDto.tipoMotor,
        host: createConnectionDto.host,
        dbName: createConnectionDto.dbName,
        connectionStringEncriptada,
        workspaceId: createConnectionDto.workspaceId,
      },
    });
  }

  /**
   * Retorna todas las conexiones registradas, opcionalmente filtradas por Workspace.
   * @param workspaceId ID opcional de filtrado
   */
  async findAll(workspaceId?: string) {
    return this.prisma.conexionDB.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      include: {
        workspace: {
          select: {
            id: true,
            nombreEmpresa: true,
          },
        },
      },
      orderBy: {
        id: 'desc',
      },
    });
  }

  /**
   * Retorna una conexión específica por su ID.
   * @param id UUID de la conexión
   */
  async findOne(id: string) {
    const conexion = await this.prisma.conexionDB.findUnique({
      where: { id },
      include: {
        workspace: {
          select: {
            id: true,
            nombreEmpresa: true,
          },
        },
      },
    });

    if (!conexion) {
      throw new NotFoundException(`Conexión con ID ${id} no encontrada`);
    }

    return conexion;
  }

  /**
   * Actualiza los datos de una conexión. Si se incluye una nueva connectionString, se re-encripta con AES-256.
   * @param id UUID de la conexión
   * @param updateConnectionDto Campos a actualizar
   */
  async update(id: string, updateConnectionDto: UpdateConnectionDto) {
    await this.findOne(id);

    if (updateConnectionDto.workspaceId) {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: updateConnectionDto.workspaceId },
      });

      if (!workspace) {
        throw new NotFoundException(
          `El Workspace con ID ${updateConnectionDto.workspaceId} no fue encontrado`,
        );
      }
    }

    const dataToUpdate: any = {};

    if (updateConnectionDto.tipoMotor !== undefined) {
      dataToUpdate.tipoMotor = updateConnectionDto.tipoMotor;
    }
    if (updateConnectionDto.host !== undefined) {
      dataToUpdate.host = updateConnectionDto.host;
    }
    if (updateConnectionDto.dbName !== undefined) {
      dataToUpdate.dbName = updateConnectionDto.dbName;
    }
    if (updateConnectionDto.workspaceId !== undefined) {
      dataToUpdate.workspaceId = updateConnectionDto.workspaceId;
    }
    if (updateConnectionDto.connectionString !== undefined) {
      dataToUpdate.connectionStringEncriptada = this.encryptionService.encrypt(
        updateConnectionDto.connectionString,
      );
    }

    return this.prisma.conexionDB.update({
      where: { id },
      data: dataToUpdate,
    });
  }

  /**
   * Elimina una conexión por su ID.
   * @param id UUID de la conexión
   */
  async remove(id: string) {
    await this.findOne(id);

    return this.prisma.conexionDB.delete({
      where: { id },
    });
  }

  /**
   * Obtiene la conexión y desencripta sus credenciales usando AES-256.
   * @param id UUID de la conexión
   */
  async getDecrypted(id: string) {
    const conexion = await this.findOne(id);
    const decryptedConnectionString = this.encryptionService.decrypt(
      conexion.connectionStringEncriptada,
    );

    return {
      ...conexion,
      connectionStringDesencriptada: decryptedConnectionString,
    };
  }
}
