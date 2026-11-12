import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ExcelRow } from './excel-parser.js';

export interface ExcelSheetData {
  nombre: string;
  columnas: string[];
  columnaId: string;
  filas: ExcelRow[];
}

/** Hojas leídas recientemente que se mantienen en memoria (cada una pesa como mucho lo que el archivo subido). */
const CACHE_SIZE = 12;

/**
 * Lectura de las hojas guardadas para el adaptador EXCEL. Las filas de una hoja se leen de PostgreSQL una sola vez y
 * se reutilizan mientras el archivo no cambie (la versión es su `updatedAt`): paginar o cruzar no vuelve a traer el
 * JSON completo. El workspace ya lo verificó ConnectionsService al resolver el id.
 */
@Injectable()
export class ExcelSheetStore {
  private readonly cache = new Map<string, { version: number; data: ExcelSheetData }>();

  constructor(private readonly prisma: PrismaService) {}

  async sheetNames(archivoId: string): Promise<string[]> {
    const sheets = await this.prisma.hojaExcel.findMany({ where: { archivoId }, select: { nombre: true }, orderBy: { posicion: 'asc' } });
    return sheets.map((sheet) => sheet.nombre);
  }

  async columns(archivoId: string, nombre: string): Promise<string[]> {
    const sheet = await this.prisma.hojaExcel.findUnique({ where: { archivoId_nombre: { archivoId, nombre } }, select: { columnas: true } });
    if (!sheet) throw new NotFoundException(`La hoja "${nombre}" no existe en el archivo`);
    return sheet.columnas as string[];
  }

  async sheet(archivoId: string, nombre: string): Promise<ExcelSheetData> {
    const meta = await this.prisma.hojaExcel.findUnique({
      where: { archivoId_nombre: { archivoId, nombre } },
      select: { id: true, archivo: { select: { updatedAt: true } } },
    });
    if (!meta) throw new NotFoundException(`La hoja "${nombre}" no existe en el archivo`);
    const version = meta.archivo.updatedAt.getTime();
    const hit = this.cache.get(meta.id);
    if (hit?.version === version) {
      // Se mueve al final: el Map conserva el orden de inserción y se descarta la menos usada.
      this.cache.delete(meta.id);
      this.cache.set(meta.id, hit);
      return hit.data;
    }
    const row = await this.prisma.hojaExcel.findUniqueOrThrow({
      where: { id: meta.id },
      select: { nombre: true, columnas: true, columnaId: true, filas: true },
    });
    const columnas = row.columnas as string[];
    // JSONB no conserva el orden de las llaves: se reconstruye cada registro en el orden de las columnas del archivo.
    const filas = (row.filas as ExcelRow[]).map((record) => Object.fromEntries(columnas.map((column) => [column, record[column] ?? null])));
    const data: ExcelSheetData = { nombre: row.nombre, columnas, columnaId: row.columnaId, filas };
    this.cache.delete(meta.id);
    this.cache.set(meta.id, { version, data });
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    return data;
  }
}
