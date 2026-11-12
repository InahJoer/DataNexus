import { Injectable, PayloadTooLargeException } from '@nestjs/common';
import { ExcelSheetStore } from '../../excel-sources/excel-sheet-store.js';
import { ExcelTableStore } from '../../excel-sources/excel-table-store.js';
import { getMaxSourceRows } from '../data-engine.constants.js';
import type { DataPage, DataPageOptions } from '../pagination/keyset.js';
import type { CatalogObject, DataSourceConnection, ExtractOptions, IDataSourceAdapter } from './data-source-adapter.interface.js';

/**
 * Archivos de Excel subidos al workspace (ver ExcelSourcesModule). Cada hoja vive en su propia tabla de PostgreSQL:
 * los filtros, la paginación y el semi-join (`keyIn`) se ejecutan en la base de datos con índices, así que una hoja
 * de millones de filas se explora sin cargarla en memoria. La paginación avanza por la posición del registro.
 */
@Injectable()
export class ExcelAdapter implements IDataSourceAdapter {
  readonly tipoMotor = 'EXCEL' as const;
  readonly capabilities = { explore: true, fields: true, extract: true };
  readonly supportsKeyIn = true;

  constructor(
    private readonly sheets: ExcelSheetStore,
    private readonly tables: ExcelTableStore,
  ) {}

  async listObjects(connection: DataSourceConnection): Promise<CatalogObject[]> {
    return (await this.sheets.sheetNames(connection.id)).map((name) => ({ name, type: 'TABLE' }));
  }

  listFields(connection: DataSourceConnection, objectName: string): Promise<string[]> {
    return this.sheets.columns(connection.id, objectName);
  }

  async extract(connection: DataSourceConnection, entityName: string, options?: ExtractOptions): Promise<Record<string, any>[]> {
    const sheet = await this.sheets.sheet(connection.id, entityName);
    const max = getMaxSourceRows();
    const rows = await this.tables.extract(sheet, { filters: options?.filters, keyIn: options?.keyIn, maxRows: max });
    if (rows.length > max) {
      throw new PayloadTooLargeException(
        `La hoja "${entityName}" devuelve más de ${max.toLocaleString('es')} registros y es el máximo por fuente; agrega filtros o únela por su identificador con otra fuente`,
      );
    }
    return rows;
  }

  async readPage(connection: DataSourceConnection, entityName: string, options: DataPageOptions): Promise<DataPage> {
    const sheet = await this.sheets.sheet(connection.id, entityName);
    const after = typeof options.after?.[0] === 'number' ? options.after[0] : null;
    const page = await this.tables.readPage(sheet, options.filters, after, options.pageSize);
    return { rows: page.rows, orderBy: [sheet.columnaId], lastKey: page.lastKey === null ? null : [page.lastKey] };
  }
}
