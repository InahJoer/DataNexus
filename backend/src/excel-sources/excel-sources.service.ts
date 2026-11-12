import { unlink } from 'node:fs/promises';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser, RequestAuditContext } from '../auth/interfaces/authenticated-user.interface.js';
import { hasPermission } from '../auth/interfaces/user-role.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { connectionIdsOf } from '../queries/saved-queries.service.js';
import type { ExcelFileResponseDto, UploadedExcelFile } from './dto/excel-file.dto.js';
import { EXCEL_MAX_SHEETS, SheetAssembler, detectFileFormat, getExcelMaxRows, readWorkbook, uniqueName } from './excel-parser.js';
import { ExcelSheetStore } from './excel-sheet-store.js';
import { ExcelTableStore, type ExcelColumnType, type TableLoader } from './excel-table-store.js';

const FILE_SELECT = {
  id: true,
  nombre: true,
  nombreArchivo: true,
  tamanoBytes: true,
  creadoPor: true,
  createdAt: true,
  updatedAt: true,
  estado: true,
  progreso: true,
  filasProcesadas: true,
  error: true,
  avisos: true,
  hojas: { select: { nombre: true, columnas: true, columnaId: true, totalFilas: true, tipos: true }, orderBy: { posicion: 'asc' } },
} as const satisfies Prisma.ArchivoExcelSelect;

type FileRow = Prisma.ArchivoExcelGetPayload<{ select: typeof FILE_SELECT }>;

/** Cargas simultáneas por instancia: las demás esperan su turno (estado PROCESANDO con progreso 0). */
const MAX_CONCURRENT_LOADS = 2;
/** Cada cuánto se guarda el avance de una carga. */
const PROGRESS_EVERY_MS = 1_000;
/** Filas entre CHECKPOINT en discos pequeños (EXCEL_DB_MAX_MB), para que el WAL no crezca sin control. */
const CHECKPOINT_EVERY_ROWS = 200_000;

interface LoadJob {
  kind: 'upload' | 'replace';
  archivoId: string;
  path: string;
  originalname: string;
  size: number;
  actor: AuthenticatedUser;
  context: RequestAuditContext;
}

interface LoadedSheet {
  nombre: string;
  posicion: number;
  columnas: string[];
  columnaId: string;
  tipos: ExcelColumnType[];
  totalFilas: number;
  tabla: string;
}

class LoadCancelled extends Error {}

/**
 * Archivos de Excel del workspace. La subida solo guarda el archivo en disco y responde de inmediato; la lectura
 * corre en segundo plano por streaming (sin cargar el libro en memoria) e inserta cada hoja en su propia tabla de
 * PostgreSQL (ver ExcelTableStore), así que admite archivos de cientos de MB y millones de registros. Mientras
 * tanto el archivo está PROCESANDO con su avance; al terminar queda LISTO y se explora y cruza como cualquier conexión.
 */
@Injectable()
export class ExcelSourcesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExcelSourcesService.name);
  private readonly queue: LoadJob[] = [];
  private running = 0;
  private readonly loading = new Set<string>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tables: ExcelTableStore,
    private readonly sheets: ExcelSheetStore,
  ) {}

  /** Al arrancar: las cargas que se cortaron por un reinicio se marcan y se limpian sus tablas a medias. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const interrupted = await this.prisma.archivoExcel.findMany({
        where: { estado: 'PROCESANDO' },
        select: { id: true, updatedAt: true, hojas: { select: { tabla: true } } },
      });
      for (const file of interrupted) {
        await this.dropOrphanTables(file.id, file.hojas.map((sheet) => sheet.tabla));
        const message = 'La carga se interrumpió porque el servidor se reinició: vuelve a subir el archivo';
        await this.prisma.archivoExcel.update({
          where: { id: file.id },
          data: file.hojas.length
            ? { estado: 'LISTO', progreso: 100, error: message, updatedAt: file.updatedAt }
            : { estado: 'ERROR', progreso: 0, error: message, updatedAt: file.updatedAt },
        });
      }
      void this.sheets.migrateLegacy();
    } catch (error) {
      this.logger.warn(`No se pudieron revisar las cargas de Excel pendientes: ${(error as Error).message}`);
    }
  }

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

  /** Registra el archivo como PROCESANDO y encola su lectura; responde sin esperar a que termine. */
  async upload(actor: AuthenticatedUser, file: UploadedExcelFile | undefined, nombre: string | undefined, context: RequestAuditContext) {
    const { path, originalname, size } = await this.acceptFile(actor, file);
    const record = await this.prisma.archivoExcel.create({
      data: {
        nombre: nombre || originalname.replace(/\.[^.]+$/, '').slice(0, 120) || 'Excel',
        nombreArchivo: originalname.slice(0, 255),
        tamanoBytes: BigInt(size),
        creadoPor: actor.email,
        workspaceId: actor.workspaceId,
        estado: 'PROCESANDO',
        progreso: 0,
        filasProcesadas: 0,
      },
      select: FILE_SELECT,
    });
    this.enqueue({ kind: 'upload', archivoId: record.id, path, originalname, size, actor, context });
    return this.toResponse(record);
  }

  /**
   * Sustituye el contenido conservando el id: los reportes guardados que usan el Excel siguen funcionando. Los datos
   * anteriores se siguen leyendo hasta que la nueva carga termina.
   */
  async replace(actor: AuthenticatedUser, id: string, file: UploadedExcelFile | undefined, context: RequestAuditContext) {
    let accepted: { path: string; originalname: string; size: number } | null = null;
    try {
      const current = await this.find(actor, id);
      if (current.estado === 'PROCESANDO') throw new ConflictException('El archivo todavía se está cargando: espera a que termine');
      accepted = await this.acceptFile(actor, file);
      const record = await this.prisma.archivoExcel.update({
        where: { id },
        // updatedAt se conserva: es la versión de los datos y no cambian hasta que la carga termine.
        data: { estado: 'PROCESANDO', progreso: 0, filasProcesadas: 0, error: null, updatedAt: current.updatedAt },
        select: FILE_SELECT,
      });
      this.enqueue({ kind: 'replace', archivoId: id, ...accepted, actor, context });
      return this.toResponse(record);
    } catch (error) {
      if (!accepted) await this.discard(file);
      throw error;
    }
  }

  async rename(actor: AuthenticatedUser, id: string, nombre: string): Promise<ExcelFileResponseDto> {
    this.assertCanManage(actor);
    const current = await this.find(actor, id);
    // El nombre no cambia los datos: no se toca updatedAt para no invalidar las vistas abiertas.
    const record = await this.prisma.archivoExcel.update({ where: { id }, data: { nombre, updatedAt: current.updatedAt }, select: FILE_SELECT });
    return this.toResponse(record);
  }

  async remove(actor: AuthenticatedUser, id: string, context: RequestAuditContext): Promise<void> {
    this.assertCanManage(actor);
    const current = await this.find(actor, id);
    const tablas = await this.prisma.hojaExcel.findMany({ where: { archivoId: id }, select: { tabla: true } });
    // Si se está cargando, la carga se detiene en el siguiente lote y borra sus tablas.
    this.cancelled.add(id);
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
    await this.tables.drop(tablas.flatMap((sheet) => (sheet.tabla ? [sheet.tabla] : [])));
    // Una carga que aún esperaba turno se descarta sin empezar.
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index].archivoId !== id) continue;
      await this.discardPath(this.queue[index].path);
      this.queue.splice(index, 1);
    }
    if (!this.loading.has(id)) this.cancelled.delete(id);
  }

  /** Espera a que no queden cargas en curso (pruebas y apagado ordenado). */
  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private enqueue(job: LoadJob): void {
    this.queue.push(job);
    this.next();
  }

  private next(): void {
    while (this.running < MAX_CONCURRENT_LOADS && this.queue.length) {
      const job = this.queue.shift()!;
      this.running += 1;
      this.loading.add(job.archivoId);
      // Una carga nunca debe tumbar la API: cualquier error que escape de process() solo se registra.
      void this.process(job)
        .catch((error: Error) => this.logger.error(`La carga del Excel ${job.archivoId} terminó con un error: ${error.message}`))
        .finally(() => {
        this.running -= 1;
        this.loading.delete(job.archivoId);
        this.cancelled.delete(job.archivoId);
        this.next();
      });
    }
  }

  /** Lee el libro por streaming y guarda cada hoja en su tabla; al final publica las hojas en una transacción. */
  private async process(job: LoadJob): Promise<void> {
    const created: string[] = [];
    const loaded: LoadedSheet[] = [];
    const avisos: string[] = [];
    const started = Date.now();
    let fraction = 0;
    let rows = 0;
    let lastReport = 0;
    let lastCheckpoint = 0;
    const maxRows = getExcelMaxRows();

    const report = async (force = false) => {
      if (this.cancelled.has(job.archivoId)) throw new LoadCancelled();
      if (!force && Date.now() - lastReport < PROGRESS_EVERY_MS) return;
      lastReport = Date.now();
      // Se detiene antes de llenar el disco de la base de datos (EXCEL_DB_MAX_MB) y, en discos pequeños, recicla el WAL.
      if (rows - lastCheckpoint >= CHECKPOINT_EVERY_ROWS) {
        lastCheckpoint = rows;
        await this.tables.checkpoint();
      }
      await this.tables.assertStorage();
      const progreso = Math.min(99, Math.floor(fraction * 100));
      // Sin tocar updatedAt (es la versión de los datos): por eso SQL directo y no update de Prisma.
      await this.prisma.$executeRaw`UPDATE "ArchivoExcel" SET "progreso" = ${progreso}, "filasProcesadas" = ${rows} WHERE "id" = ${job.archivoId}`;
    };

    try {
      await this.tables.assertStorage();
      const used = new Set<string>();
      for await (const raw of readWorkbook(job.path, job.originalname, (value) => (fraction = value))) {
        const assembler = new SheetAssembler(uniqueName(raw.nombre, used));
        let loader: TableLoader | null = null;
        let tabla = '';
        for await (const batch of raw.rows) {
          for (const cells of batch) {
            const row = assembler.push(cells);
            if (!loader && assembler.hasHeader) {
              if (loaded.length >= EXCEL_MAX_SHEETS) throw new BadRequestException(`El libro tiene más de ${EXCEL_MAX_SHEETS} hojas con datos`);
              tabla = this.tables.newTableName(job.archivoId);
              created.push(tabla);
              loader = await this.tables.createLoader(tabla, assembler.columnas);
            }
            if (!row || !loader) continue;
            await loader.add(row);
            rows += 1;
            if (rows > maxRows) throw new BadRequestException(`El archivo supera el máximo de ${maxRows.toLocaleString('es')} registros configurado`);
          }
          await report();
        }
        if (!loader) continue;
        const result = await loader.finish();
        const sheetWarnings = [...assembler.finish(), ...result.avisos];
        loaded.push({
          nombre: assembler.nombre,
          posicion: loaded.length,
          columnas: assembler.columnas,
          columnaId: assembler.columnas[0],
          tipos: result.tipos,
          totalFilas: result.totalFilas,
          tabla,
        });
        avisos.push(...sheetWarnings.map((aviso) => `${assembler.nombre}: ${aviso}`));
        await report(true);
      }
      if (!loaded.length) throw new BadRequestException('El archivo no tiene hojas con datos: la fila 1 debe tener los encabezados');
      // Con una sola hoja, los avisos no necesitan el nombre de la hoja delante.
      const finalWarnings = loaded.length === 1 ? avisos.map((aviso) => aviso.slice(loaded[0].nombre.length + 2)) : avisos;
      await this.publish(job, loaded, finalWarnings);
      this.logger.log(
        `Excel ${job.archivoId}: ${rows} registros en ${loaded.length} hoja(s) cargados en ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );
    } catch (error) {
      await this.tables.drop(created);
      if (error instanceof LoadCancelled || this.cancelled.has(job.archivoId)) return;
      const message =
        error instanceof HttpException
          ? error.message
          : isDiskFull(error)
            ? 'La base de datos se quedó sin espacio en disco: amplía su volumen o sube un archivo más pequeño'
            : 'No se pudo procesar el archivo: verifica que no esté dañado';
      if (!(error instanceof HttpException)) this.logger.error(`Falló la carga del Excel ${job.archivoId}: ${(error as Error).message}`);
      // Si la base de datos no responde (p. ej. se reinicia), el estado se corrige al arrancar de nuevo.
      await this.fail(job, message).catch((failure: Error) =>
        this.logger.error(`No se pudo marcar el Excel ${job.archivoId} como fallido: ${failure.message}`),
      );
    } finally {
      await this.discardPath(job.path);
    }
  }

  private async publish(job: LoadJob, loaded: LoadedSheet[], avisos: string[]): Promise<void> {
    const previous = await this.prisma.$transaction(async (tx) => {
      const current = await tx.archivoExcel.findUnique({ where: { id: job.archivoId }, select: { nombre: true, hojas: { select: { tabla: true } } } });
      if (!current) throw new LoadCancelled();
      await tx.hojaExcel.deleteMany({ where: { archivoId: job.archivoId } });
      await tx.archivoExcel.update({
        where: { id: job.archivoId },
        data: {
          nombreArchivo: job.originalname.slice(0, 255),
          tamanoBytes: BigInt(job.size),
          estado: 'LISTO',
          progreso: 100,
          filasProcesadas: loaded.reduce((sum, sheet) => sum + sheet.totalFilas, 0),
          error: null,
          avisos,
          updatedAt: new Date(),
          hojas: { create: loaded.map(({ tipos, columnas, ...sheet }) => ({ ...sheet, columnas, tipos })) },
        },
      });
      await this.audit.record(
        {
          eventType: job.kind === 'upload' ? 'EXCEL_UPLOADED' : 'EXCEL_REPLACED',
          outcome: 'SUCCESS',
          actorUserId: job.actor.id,
          actorEmail: job.actor.email,
          workspaceId: job.actor.workspaceId,
          targetType: 'EXCEL',
          targetId: job.archivoId,
          details: {
            nombre: current.nombre,
            archivo: job.originalname,
            hojas: loaded.length,
            filas: loaded.reduce((sum, sheet) => sum + sheet.totalFilas, 0),
          },
          ...job.context,
        },
        tx,
      );
      return current.hojas.flatMap((sheet) => (sheet.tabla ? [sheet.tabla] : []));
    });
    await this.tables.drop(previous);
  }

  /** Una subida fallida queda en ERROR; un reemplazo fallido conserva los datos anteriores y muestra el motivo. */
  private async fail(job: LoadJob, message: string): Promise<void> {
    const current = await this.prisma.archivoExcel.findUnique({
      where: { id: job.archivoId },
      select: { updatedAt: true, _count: { select: { hojas: true } } },
    });
    if (!current) return;
    const hasData = current._count.hojas > 0;
    await this.prisma.archivoExcel.update({
      where: { id: job.archivoId },
      data: hasData
        ? { estado: 'LISTO', progreso: 100, error: `No se pudo reemplazar: ${message}`, updatedAt: current.updatedAt }
        : { estado: 'ERROR', progreso: 0, error: message, updatedAt: current.updatedAt },
    });
  }

  private async dropOrphanTables(archivoId: string, inUse: Array<string | null>): Promise<void> {
    const keep = new Set(inUse.filter(Boolean));
    const tables = await this.tables.listTables(this.tables.tablePrefix(archivoId));
    await this.tables.drop(tables.filter((table) => !keep.has(table)));
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

  /** Valida permiso, presencia y formato del archivo ya guardado en disco por multer. */
  private async acceptFile(actor: AuthenticatedUser, file: UploadedExcelFile | undefined) {
    try {
      this.assertCanManage(actor);
      if (!file) throw new BadRequestException('Adjunta el archivo .xlsx o .csv en el campo archivo');
      if (!file.path) throw new BadRequestException('El archivo debe guardarse en disco antes de procesarse');
      if (!file.size) throw new BadRequestException('El archivo está vacío');
      // multer entrega el nombre en latin1: se recupera el UTF-8 original (tildes y eñes).
      const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      await detectFileFormat(file.path, originalname);
      return { path: file.path, originalname, size: file.size };
    } catch (error) {
      await this.discard(file);
      throw error;
    }
  }

  private async discard(file: UploadedExcelFile | undefined): Promise<void> {
    if (file?.path) await this.discardPath(file.path);
  }

  private async discardPath(path: string): Promise<void> {
    await unlink(path).catch(() => undefined);
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
      tamanoBytes: Number(file.tamanoBytes),
      creadoPor: file.creadoPor,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      estado: file.estado,
      progreso: file.progreso,
      filasProcesadas: file.filasProcesadas,
      error: file.error,
      avisos: Array.isArray(file.avisos) ? (file.avisos as string[]) : [],
      hojas: file.hojas.map((sheet) => ({
        nombre: sheet.nombre,
        columnas: sheet.columnas as string[],
        columnaId: sheet.columnaId,
        totalFilas: sheet.totalFilas,
        tipos: Array.isArray(sheet.tipos) && sheet.tipos.length ? (sheet.tipos as string[]) : (sheet.columnas as string[]).map(() => 'texto'),
      })),
    };
  }
}

/** PostgreSQL sin espacio en disco (53100 disk_full o el mensaje del sistema operativo). */
function isDiskFull(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  return code === '53100' || /no space left on device|disk full/i.test(message ?? '');
}
