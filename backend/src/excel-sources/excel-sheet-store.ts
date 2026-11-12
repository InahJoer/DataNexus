import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ExcelCell, ExcelRow } from './excel-parser.js';
import { ExcelTableStore, type ExcelColumnType, type StoredSheet } from './excel-table-store.js';

/**
 * Resuelve las hojas de un archivo de Excel para el adaptador EXCEL: nombres, columnas y la tabla donde están sus
 * registros. Las hojas subidas antes de la carga masiva (registros en JSON) se pasan a su tabla la primera vez que
 * se usan, o al arrancar la aplicación. El workspace ya lo verificó ConnectionsService al resolver el id.
 */
@Injectable()
export class ExcelSheetStore {
  private readonly logger = new Logger(ExcelSheetStore.name);
  private readonly migrations = new Map<string, Promise<StoredSheet>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tables: ExcelTableStore,
  ) {}

  async sheetNames(archivoId: string): Promise<string[]> {
    const sheets = await this.prisma.hojaExcel.findMany({ where: { archivoId }, select: { nombre: true }, orderBy: { posicion: 'asc' } });
    return sheets.map((sheet) => sheet.nombre);
  }

  async columns(archivoId: string, nombre: string): Promise<string[]> {
    const sheet = await this.prisma.hojaExcel.findUnique({ where: { archivoId_nombre: { archivoId, nombre } }, select: { columnas: true } });
    if (!sheet) throw new NotFoundException(`La hoja "${nombre}" no existe en el archivo`);
    return sheet.columnas as string[];
  }

  async sheet(archivoId: string, nombre: string): Promise<StoredSheet & { columnaId: string }> {
    const row = await this.prisma.hojaExcel.findUnique({
      where: { archivoId_nombre: { archivoId, nombre } },
      select: { id: true, columnas: true, columnaId: true, tipos: true, tabla: true },
    });
    if (!row) throw new NotFoundException(`La hoja "${nombre}" no existe en el archivo`);
    if (row.tabla) {
      return { tabla: row.tabla, columnas: row.columnas as string[], tipos: row.tipos as ExcelColumnType[], columnaId: row.columnaId };
    }
    return { ...(await this.migrate(row.id, archivoId)), columnaId: row.columnaId };
  }

  /** Pasa a tablas todas las hojas que siguen en el formato JSON anterior (al arrancar, sin bloquear). */
  async migrateLegacy(): Promise<void> {
    const legacy = await this.prisma.hojaExcel.findMany({ where: { tabla: null }, select: { id: true, archivoId: true } });
    for (const sheet of legacy) {
      await this.migrate(sheet.id, sheet.archivoId).catch((error: Error) => {
        this.logger.warn(`No se pudo migrar la hoja de Excel ${sheet.id}: ${error.message}`);
      });
    }
  }

  private migrate(hojaId: string, archivoId: string): Promise<StoredSheet> {
    let running = this.migrations.get(hojaId);
    if (!running) {
      running = this.runMigration(hojaId, archivoId).finally(() => this.migrations.delete(hojaId));
      this.migrations.set(hojaId, running);
    }
    return running;
  }

  private async runMigration(hojaId: string, archivoId: string): Promise<StoredSheet> {
    const row = await this.prisma.hojaExcel.findUniqueOrThrow({ where: { id: hojaId }, select: { columnas: true, tipos: true, tabla: true, filas: true } });
    const columnas = row.columnas as string[];
    if (row.tabla) return { tabla: row.tabla, columnas, tipos: row.tipos as ExcelColumnType[] };
    const tabla = this.tables.newTableName(archivoId);
    const loader = await this.tables.createLoader(tabla, columnas);
    try {
      for (const record of (row.filas ?? []) as ExcelRow[]) {
        await loader.add(columnas.map((column): ExcelCell => record[column] ?? null));
      }
      const result = await loader.finish();
      await this.prisma.hojaExcel.update({
        where: { id: hojaId },
        data: { tabla, tipos: result.tipos, totalFilas: result.totalFilas, filas: Prisma.DbNull },
      });
      this.logger.log(`Hoja de Excel ${hojaId} migrada a la tabla ${tabla} (${result.totalFilas} registros)`);
      return { tabla, columnas, tipos: result.tipos };
    } catch (error) {
      await this.tables.drop([tabla]);
      throw error;
    }
  }
}
