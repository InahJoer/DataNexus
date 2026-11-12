import { Injectable, PayloadTooLargeException } from '@nestjs/common';
import { ExcelSheetStore } from '../../excel-sources/excel-sheet-store.js';
import { getMaxSourceRows } from '../data-engine.constants.js';
import { matchesFilters } from '../filters/filter-tree.js';
import type { DataPage, DataPageOptions } from '../pagination/keyset.js';
import type { CatalogObject, DataSourceConnection, ExtractOptions, IDataSourceAdapter } from './data-source-adapter.interface.js';

/**
 * Archivos de Excel subidos al workspace (ver ExcelSourcesModule). El "motor" está en memoria: cada hoja es una tabla
 * cuya llave es la primera columna; los filtros se evalúan aquí mismo, así que todos se consideran "empujados" y la
 * extracción solo devuelve lo que cumple. La paginación avanza por la posición del registro en la hoja.
 */
@Injectable()
export class ExcelAdapter implements IDataSourceAdapter {
  readonly tipoMotor = 'EXCEL' as const;
  readonly capabilities = { explore: true, fields: true, extract: true };

  constructor(private readonly store: ExcelSheetStore) {}

  canPushDown(): boolean {
    return true;
  }

  async listObjects(connection: DataSourceConnection): Promise<CatalogObject[]> {
    return (await this.store.sheetNames(connection.id)).map((name) => ({ name, type: 'TABLE' }));
  }

  listFields(connection: DataSourceConnection, objectName: string): Promise<string[]> {
    return this.store.columns(connection.id, objectName);
  }

  async extract(connection: DataSourceConnection, entityName: string, options?: ExtractOptions): Promise<Record<string, any>[]> {
    const { filas } = await this.store.sheet(connection.id, entityName);
    const rows = options?.filters?.length ? filas.filter((row) => matchesFilters(row, options.filters!)) : filas;
    const max = getMaxSourceRows();
    if (rows.length > max) {
      throw new PayloadTooLargeException(`La hoja "${entityName}" devuelve ${rows.length} registros y el máximo por fuente es ${max}; agrega filtros`);
    }
    return rows.map((row) => ({ ...row }));
  }

  async readPage(connection: DataSourceConnection, entityName: string, options: DataPageOptions): Promise<DataPage> {
    const { filas, columnaId } = await this.store.sheet(connection.id, entityName);
    const start = typeof options.after?.[0] === 'number' ? options.after[0] + 1 : 0;
    const rows: Record<string, any>[] = [];
    let lastIndex = -1;
    let hasMore = false;
    for (let index = start; index < filas.length; index += 1) {
      if (options.filters?.length && !matchesFilters(filas[index], options.filters)) continue;
      if (rows.length === options.pageSize) {
        hasMore = true;
        break;
      }
      rows.push({ ...filas[index] });
      lastIndex = index;
    }
    return { rows, orderBy: [columnaId], lastKey: hasMore ? [lastIndex] : null };
  }
}
