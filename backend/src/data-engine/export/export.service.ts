import { Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

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

  exportToJson(data: Record<string, any>[]): Buffer {
    this.logger.log(`Generando exportación JSON para ${data.length} registros`);
    return Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  }
}
