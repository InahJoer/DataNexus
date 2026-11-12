import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser, RequestAuditContext } from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { connectionIdsOf } from '../queries/saved-queries.service.js';
import type { ExcelFileResponseDto, UploadedExcelFile } from './dto/excel-file.dto.js';
import { parseWorkbook, type ParsedSheet } from './excel-parser.js';

const FILE_SELECT = {
  id: true,
  nombre: true,
  nombreArchivo: true,
  tamanoBytes: true,
  creadoPor: true,
  createdAt: true,
  updatedAt: true,
  hojas: { select: { nombre: true, columnas: true, columnaId: true, totalFilas: true }, orderBy: { posicion: 'asc' } },
} as const satisfies Prisma.ArchivoExcelSelect;

type FileRow = Prisma.ArchivoExcelGetPayload<{ select: typeof FILE_SELECT }>;

/**
 * Archivos de Excel del workspace: se leen al subirlos (fila 1 = encabezados, columna 1 = identificador) y se guardan
 * ya normalizados. Después se exploran y cruzan como cualquier conexión usando su id (adaptador EXCEL).
 */
@Injectable()
export class ExcelSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthenticatedUser): Promise<ExcelFileResponseDto[]> {
    const files = await this.prisma.archivoExcel.findMany({
      where: { workspaceId: actor.workspaceId },
      select: FILE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return files.map((file) => this.toResponse(file));
  }

  async get(actor: AuthenticatedUser, id: string): Promise<ExcelFileResponseDto> {
    const file = await this.find(actor, id);
    return { ...this.toResponse(file), usadoEn: await this.usage(actor, id) };
  }

  async upload(actor: AuthenticatedUser, file: UploadedExcelFile | undefined, nombre: string | undefined, context: RequestAuditContext) {
    this.assertCanManage(actor);
    const { buffer, originalname } = this.readFile(file);
    const sheets = await parseWorkbook(buffer, originalname);
    const created = await this.prisma.$transaction(async (tx) => {
      const record = await tx.archivoExcel.create({
        data: {
          nombre: nombre || originalname.replace(/\.[^.]+$/, '').slice(0, 120) || 'Excel',
          nombreArchivo: originalname.slice(0, 255),
          tamanoBytes: buffer.length,
          creadoPor: actor.email,
          workspaceId: actor.workspaceId,
          hojas: { create: sheets.map((sheet, posicion) => this.sheetData(sheet, posicion)) },
        },
        select: FILE_SELECT,
      });
      await this.audit.record(this.auditEvent('EXCEL_UPLOADED', actor, record.id, record.nombre, originalname, sheets, context), tx);
      return record;
    });
    return { ...this.toResponse(created), avisos: this.warnings(sheets) };
  }

  /** Sustituye el contenido conservando el id: los reportes guardados que usan el Excel siguen funcionando. */
  async replace(actor: AuthenticatedUser, id: string, file: UploadedExcelFile | undefined, context: RequestAuditContext) {
    this.assertCanManage(actor);
    const current = await this.find(actor, id);
    const { buffer, originalname } = this.readFile(file);
    const sheets = await parseWorkbook(buffer, originalname);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.hojaExcel.deleteMany({ where: { archivoId: id } });
      const record = await tx.archivoExcel.update({
        where: { id },
        data: {
          nombreArchivo: originalname.slice(0, 255),
          tamanoBytes: buffer.length,
          updatedAt: new Date(),
          hojas: { create: sheets.map((sheet, posicion) => this.sheetData(sheet, posicion)) },
        },
        select: FILE_SELECT,
      });
      await this.audit.record(this.auditEvent('EXCEL_REPLACED', actor, id, current.nombre, originalname, sheets, context), tx);
      return record;
    });
    return { ...this.toResponse(updated), avisos: this.warnings(sheets) };
  }

  async rename(actor: AuthenticatedUser, id: string, nombre: string): Promise<ExcelFileResponseDto> {
    this.assertCanManage(actor);
    await this.find(actor, id);
    // El nombre no cambia los datos: no se toca updatedAt para no invalidar la caché de hojas.
    const record = await this.prisma.archivoExcel.update({ where: { id }, data: { nombre }, select: FILE_SELECT });
    return this.toResponse(record);
  }

  async remove(actor: AuthenticatedUser, id: string, context: RequestAuditContext): Promise<void> {
    this.assertCanManage(actor);
    const current = await this.find(actor, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.archivoExcel.delete({ where: { id } });
      await this.audit.record(
        {
          eventType: 'EXCEL_DELETED',
          outcome: 'SUCCESS',
          actorUserId: actor.id,
          actorEmail: actor.email,
          workspaceId: actor.workspaceId,
          targetType: 'EXCEL',
          targetId: id,
          details: { nombre: current.nombre, archivo: current.nombreArchivo, hojas: current.hojas.length },
          ...context,
        },
        tx,
      );
    });
  }

  private async find(actor: AuthenticatedUser, id: string): Promise<FileRow> {
    const file = await this.prisma.archivoExcel.findFirst({ where: { id, workspaceId: actor.workspaceId }, select: FILE_SELECT });
    if (!file) throw new NotFoundException(`Archivo de Excel con ID ${id} no encontrado`);
    return file;
  }

  /** Reportes guardados del workspace que leen el archivo (se avisa antes de eliminarlo). */
  private async usage(actor: AuthenticatedUser, id: string) {
    const queries = await this.prisma.savedQuery.findMany({
      where: { workspaceId: actor.workspaceId },
      select: { id: true, nombre: true, definicion: true },
    });
    return queries
      .filter((query) => connectionIdsOf(query.definicion as Record<string, unknown>).includes(id))
      .map((query) => ({ id: query.id, nombre: query.nombre }));
  }

  private sheetData(sheet: ParsedSheet, posicion: number) {
    return {
      nombre: sheet.nombre,
      posicion,
      columnas: sheet.columnas,
      columnaId: sheet.columnaId,
      totalFilas: sheet.filas.length,
      filas: sheet.filas as Prisma.InputJsonValue,
    };
  }

  private warnings(sheets: ParsedSheet[]): string[] {
    return sheets.flatMap((sheet) => sheet.avisos.map((aviso) => (sheets.length > 1 ? `${sheet.nombre}: ${aviso}` : aviso)));
  }

  private auditEvent(
    eventType: 'EXCEL_UPLOADED' | 'EXCEL_REPLACED',
    actor: AuthenticatedUser,
    id: string,
    nombre: string,
    archivo: string,
    sheets: ParsedSheet[],
    context: RequestAuditContext,
  ) {
    return {
      eventType,
      outcome: 'SUCCESS' as const,
      actorUserId: actor.id,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      targetType: 'EXCEL' as const,
      targetId: id,
      details: { nombre, archivo, hojas: sheets.length, filas: sheets.reduce((sum, sheet) => sum + sheet.filas.length, 0) },
      ...context,
    };
  }

  private readFile(file: UploadedExcelFile | undefined): { buffer: Buffer; originalname: string } {
    if (!file) throw new BadRequestException('Adjunta el archivo .xlsx o .csv en el campo archivo');
    if (file.path || !file.buffer) throw new BadRequestException('El archivo debe procesarse en memoria');
    if (!file.buffer.length) throw new BadRequestException('El archivo está vacío');
    // multer entrega el nombre en latin1: se recupera el UTF-8 original (tildes y eñes).
    const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return { buffer: file.buffer, originalname };
  }

  private assertCanManage(actor: AuthenticatedUser): void {
    if (!hasPermission(actor.role, 'MANAGE_EXCEL')) {
      throw new ForbiddenException('Solo ADMIN u OPERADOR pueden subir o modificar archivos de Excel');
    }
  }

  private toResponse(file: FileRow): ExcelFileResponseDto {
    return {
      id: file.id,
      nombre: file.nombre,
      nombreArchivo: file.nombreArchivo,
      tamanoBytes: file.tamanoBytes,
      creadoPor: file.creadoPor,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      hojas: file.hojas.map((sheet) => ({
        nombre: sheet.nombre,
        columnas: sheet.columnas as string[],
        columnaId: sheet.columnaId,
        totalFilas: sheet.totalFilas,
      })),
    };
  }
}
