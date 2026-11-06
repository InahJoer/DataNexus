import { Injectable, Logger } from '@nestjs/common';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export const WORD_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Metadatos que acompañan al documento Word (RF-21). */
export interface WordExportOptions {
  title: string;
  /** Fecha de generación; por defecto, ahora. */
  generatedAt?: Date;
  /** true si los datos llegaron enmascarados por el rol de quien exporta. */
  masked?: boolean;
  /** Zona horaria IANA para mostrar la fecha. Por defecto UTC. */
  timeZone?: string;
}

const BRAND_COLOR = '1F4E78';
const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' } as const;

/** Columnas en orden de aparición, aunque no todas las filas tengan las mismas claves. */
function columnsOf(data: Record<string, unknown>[]): string[] {
  const columns = new Set<string>();
  for (const row of data) for (const key of Object.keys(row)) columns.add(key);
  return [...columns];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value) ?? String(value);
  return String(value);
}

/** Encabezado de página: la marca una sola vez aunque el título ya empiece por "DataNexus". */
function pageHeaderText(title: string): string {
  return /^datanexus\b/i.test(title.trim()) ? title : `DataNexus · ${title}`;
}

function formatDate(date: Date, timeZone = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('es', { dateStyle: 'long', timeStyle: 'short', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('es', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(date);
  }
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  async exportToExcel(data: Record<string, any>[]): Promise<Buffer> {
    this.logger.log(`Generando exportación Excel para ${data.length} registros`);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DataNexus BI Platform';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Datos Cross-Join');

    if (data.length > 0) {
      const keys = Object.keys(data[0]);
      worksheet.columns = keys.map((key) => ({
        header: key.toUpperCase(),
        key,
        width: Math.max(key.length + 6, 18),
      }));

      // Estilo de encabezados corporativos
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F4E78' },
      };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 24;

      // Filas de datos
      data.forEach((item) => {
        worksheet.addRow(item);
      });

      // Bordes y alineación
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
          row.eachCell((cell) => {
            cell.border = {
              top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
              bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
              left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
              right: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            };
          });
        }
      });
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  async writeExcel(data: Record<string, unknown>[], destination: Writable): Promise<void> {
    this.logger.log(`Generando exportación Excel en streaming para ${data.length} registros`);

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: destination,
      useStyles: true,
      useSharedStrings: false,
    });
    workbook.creator = 'DataNexus BI Platform';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Datos Cross-Join');

    if (data.length > 0) {
      const keys = Object.keys(data[0]);
      worksheet.columns = keys.map((key) => ({
        header: key.toUpperCase(),
        key,
        width: Math.max(key.length + 6, 18),
      }));

      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F4E78' },
      };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 24;
      headerRow.commit();

      for (const item of data) {
        const row = worksheet.addRow(item);
        row.eachCell((cell) => {
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            right: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          };
        });
        row.commit();
      }
    }

    worksheet.commit();
    await workbook.commit();
  }

  async exportToPdf(data: Record<string, any>[], title = 'DataNexus - Reporte Cross-Join'): Promise<Buffer> {
    this.logger.log(`Generando exportación PDF para ${data.length} registros`);

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err: Error) => reject(err));

      // Encabezado
      doc.fontSize(18).fillColor('#1F4E78').text(title, { align: 'center' });
      doc.moveDown(0.4);
      doc
        .fontSize(9)
        .fillColor('#666666')
        .text(`Generado: ${new Date().toLocaleString()} | Total Registros: ${data.length}`, {
          align: 'center',
        });
      doc.moveDown(1);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#1F4E78').stroke();
      doc.moveDown(0.8);

      if (data.length === 0) {
        doc.fontSize(11).fillColor('#888888').text('No hay registros disponibles para exportar.');
      } else {
        data.forEach((item, index) => {
          if (doc.y > 700) {
            doc.addPage();
          }

          doc
            .fontSize(10)
            .fillColor('#1F4E78')
            .text(`[#${index + 1}] Registro Consolidado`, { underline: true });
          doc.fontSize(8.5).fillColor('#333333');

          for (const [key, value] of Object.entries(item)) {
            const strVal = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
            doc.text(`   • ${key}: ${strVal}`);
          }

          doc.moveDown(0.5);
        });
      }

      doc.end();
    });
  }

  async writePdf(
    data: Record<string, unknown>[],
    title: string,
    destination: Writable,
  ): Promise<void> {
    this.logger.log(`Generando exportación PDF en streaming para ${data.length} registros`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const transfer = pipeline(doc, destination);

    try {
      doc.fontSize(18).fillColor('#1F4E78').text(title, { align: 'center' });
      doc.moveDown(0.4);
      doc
        .fontSize(9)
        .fillColor('#666666')
        .text(`Generado: ${new Date().toLocaleString()} | Total Registros: ${data.length}`, {
          align: 'center',
        });
      doc.moveDown(1);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#1F4E78').stroke();
      doc.moveDown(0.8);

      if (data.length === 0) {
        doc.fontSize(11).fillColor('#888888').text('No hay registros disponibles para exportar.');
      } else {
        data.forEach((item, index) => {
          if (doc.y > 700) {
            doc.addPage();
          }

          doc
            .fontSize(10)
            .fillColor('#1F4E78')
            .text(`[#${index + 1}] Registro Consolidado`, { underline: true });
          doc.fontSize(8.5).fillColor('#333333');

          for (const [key, value] of Object.entries(item)) {
            const strVal =
              typeof value === 'object' && value !== null
                ? (JSON.stringify(value) ?? String(value))
                : String(value ?? '');
            doc.text(`   • ${key}: ${strVal}`);
          }

          doc.moveDown(0.5);
        });
      }

      doc.end();
      await transfer;
    } catch (error) {
      doc.destroy(error instanceof Error ? error : new Error(String(error)));
      await transfer.catch(() => undefined);
      throw error;
    }
  }

  /**
   * Documento Word (.docx) con encabezado, metadatos, fecha y una tabla con los datos (RF-21).
   * Recibe los datos ya enmascarados según el rol: aquí no se decide qué se muestra.
   */
  async exportToWord(data: Record<string, unknown>[], options: WordExportOptions): Promise<Buffer> {
    this.logger.log(`Generando exportación Word para ${data.length} registros`);

    const generatedAt = options.generatedAt ?? new Date();
    const columns = columnsOf(data);
    const generatedLabel = formatDate(generatedAt, options.timeZone);

    const metadata: Array<[string, string]> = [
      ['Generado', generatedLabel],
      ['Registros', data.length.toLocaleString('es')],
      ['Columnas', String(columns.length)],
    ];
    if (options.masked !== undefined) {
      metadata.push(['Datos sensibles', options.masked ? 'Enmascarados según el rol' : 'Sin enmascarar']);
    }

    const children: Array<Paragraph | Table> = [
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: options.title, color: BRAND_COLOR })] }),
      ...metadata.map(
        ([label, value]) =>
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun({ text: value })],
          }),
      ),
      new Paragraph({ text: '', spacing: { after: 120 } }),
    ];

    if (data.length === 0 || columns.length === 0) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: 'No hay registros disponibles para exportar.', italics: true })] }),
      );
    } else {
      children.push(this.buildWordTable(data, columns));
    }

    const document = new Document({
      creator: 'DataNexus BI Platform',
      title: options.title,
      subject: 'Exportación de Cross-Join',
      description: `${data.length} registros generados el ${generatedLabel}`,
      styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
      sections: [
        {
          properties: {
            page: {
              // Horizontal: las tablas de un join suelen tener muchas columnas.
              size: { orientation: PageOrientation.LANDSCAPE },
              margin: { top: 720, bottom: 720, left: 720, right: 720 },
            },
          },
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  alignment: AlignmentType.RIGHT,
                  children: [new TextRun({ text: pageHeaderText(options.title), size: 16, color: '666666' })],
                }),
              ],
            }),
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      size: 16,
                      color: '666666',
                      children: ['Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES],
                    }),
                  ],
                }),
              ],
            }),
          },
          children,
        },
      ],
    });

    return Packer.toBuffer(document);
  }

  /** Igual que exportToWord, escrito en el destino del reporte (almacenamiento local, S3 o GCS). */
  async writeWord(
    data: Record<string, unknown>[],
    options: WordExportOptions,
    destination: Writable,
  ): Promise<void> {
    const buffer = await this.exportToWord(data, options);
    await pipeline(Readable.from([buffer]), destination);
  }

  private buildWordTable(data: Record<string, unknown>[], columns: string[]): Table {
    const borders = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };
    const header = new TableRow({
      // Se repite en cada página.
      tableHeader: true,
      children: columns.map(
        (column) =>
          new TableCell({
            borders,
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: BRAND_COLOR },
            children: [
              new Paragraph({ children: [new TextRun({ text: column.toUpperCase(), bold: true, color: 'FFFFFF' })] }),
            ],
          }),
      ),
    });

    const rows = data.map(
      (row, index) =>
        new TableRow({
          cantSplit: true,
          children: columns.map(
            (column) =>
              new TableCell({
                borders,
                shading:
                  index % 2 === 1 ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F6FA' } : undefined,
                children: [new Paragraph({ children: [new TextRun({ text: cellText(row[column]) })] })],
              }),
          ),
        }),
    );

    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows] });
  }

  exportToJson(data: Record<string, any>[]): Buffer {
    this.logger.log(`Generando exportación JSON para ${data.length} registros`);
    return Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  }
}
