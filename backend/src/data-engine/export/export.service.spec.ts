import { PassThrough } from 'node:stream';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { ExportService } from './export.service.js';

describe('ExportService', () => {
  const service = new ExportService();

  const sampleData = [
    { id: '1', nombre: 'Test A', total: 100 },
    { id: '2', nombre: 'Test B', total: 250 },
  ];

  it('exports dataset to valid Excel buffer', async () => {
    const buffer = await service.exportToExcel(sampleData);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('exports dataset to valid PDF buffer', async () => {
    const buffer = await service.exportToPdf(sampleData, 'Reporte de Prueba');
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    // Verificamos cabecera PDF standard %PDF
    expect(buffer.toString('utf-8', 0, 4)).toBe('%PDF');
  });

  it('exports dataset to valid JSON buffer', () => {
    const buffer = service.exportToJson(sampleData);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const parsed = JSON.parse(buffer.toString('utf-8'));
    expect(parsed).toEqual(sampleData);
  });
});

describe('ExportService – Word (.docx, RF-21)', () => {
  const service = new ExportService();
  const generatedAt = new Date('2026-11-06T18:30:00Z');

  async function unzip(buffer: Buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const read = async (path: string) => {
      const file = zip.file(path);
      if (!file) throw new Error(`Falta ${path} en el .docx`);
      return file.async('string');
    };
    return { zip, read };
  }

  it('genera un ZIP de Office Open XML con cabecera binaria PK\\x03\\x04', async () => {
    const buffer = await service.exportToWord([{ id: 1 }], { title: 'Cabecera', generatedAt });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    // Firma de un archivo ZIP: "PK" + 0x03 0x04.
    expect([...buffer.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const { read } = await unzip(buffer);
    expect(await read('[Content_Types].xml')).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    );
    expect(await read('word/document.xml')).toContain('<w:document');
  });

  it('incluye encabezado, metadatos, fecha y la tabla con todas las columnas', async () => {
    const data = [
      { id: '1', nombre: 'Cliente A', total: 100 },
      { id: '2', nombre: 'Cliente B', total: 250, pais: 'NI' },
    ];
    const buffer = await service.exportToWord(data, {
      title: 'Ventas por cliente',
      generatedAt,
      masked: true,
      timeZone: 'America/Managua',
    });
    const { zip, read } = await unzip(buffer);
    const document = await read('word/document.xml');

    expect(document).toContain('Ventas por cliente');
    expect(document).toContain('Registros: ');
    expect(document).toContain('>2<');
    expect(document).toContain('Columnas: ');
    expect(document).toContain('6 de noviembre de 2026');
    expect(document).toContain('Enmascarados según el rol');
    // Encabezados en mayúsculas, incluida la columna que solo tiene la segunda fila.
    for (const column of ['ID', 'NOMBRE', 'TOTAL', 'PAIS']) expect(document).toContain(`>${column}<`);
    for (const value of ['Cliente A', 'Cliente B', '250', 'NI']) expect(document).toContain(`>${value}<`);
    expect(document).toContain('<w:tblHeader');
    expect(document).toContain('w:orient="landscape"');

    const headerFile = Object.keys(zip.files).find((name) => /^word\/header\d*\.xml$/.test(name));
    expect(headerFile).toBeDefined();
    expect(await read(headerFile!)).toContain('DataNexus · Ventas por cliente');

    const core = await read('docProps/core.xml');
    expect(core).toContain('Ventas por cliente');
    expect(core).toContain('DataNexus BI Platform');
  });

  it('no repite la marca en el encabezado si el título ya la incluye', async () => {
    const buffer = await service.exportToWord([{ id: 1 }], { title: 'DataNexus - Join clientes x pedidos', generatedAt });
    const { zip, read } = await unzip(buffer);
    const headerFile = Object.keys(zip.files).find((name) => /^word\/header\d*\.xml$/.test(name))!;
    const header = await read(headerFile);

    expect(header).toContain('>DataNexus - Join clientes x pedidos<');
    expect(header).not.toContain('DataNexus · DataNexus');
  });

  it('escapa caracteres especiales y serializa objetos, fechas y nulos', async () => {
    const buffer = await service.exportToWord(
      [{ nota: '<script>&"x"', detalle: { a: 1 }, fecha: new Date('2026-01-02T03:04:05Z'), vacio: null }],
      { title: 'Escape & <prueba>', generatedAt },
    );
    const document = await (await unzip(buffer)).read('word/document.xml');

    expect(document).toContain('&lt;script&gt;&amp;');
    expect(document).not.toContain('<script>');
    expect(document).toContain('Escape &amp; &lt;prueba&gt;');
    expect(document).toContain('{&quot;a&quot;:1}');
    expect(document).toContain('2026-01-02T03:04:05.000Z');
  });

  it('indica cuando no hay registros', async () => {
    const buffer = await service.exportToWord([], { title: 'Vacío', generatedAt, masked: false });
    const document = await (await unzip(buffer)).read('word/document.xml');

    expect(document).toContain('No hay registros disponibles para exportar.');
    expect(document).toContain('Sin enmascarar');
    expect(document).not.toContain('<w:tbl>');
  });

  it('escribe el mismo documento en un stream de reporte', async () => {
    const chunks: Buffer[] = [];
    const destination = new PassThrough();
    destination.on('data', (chunk: Buffer) => chunks.push(chunk));

    await service.writeWord([{ id: 1 }], { title: 'Stream', generatedAt }, destination);

    const buffer = Buffer.concat(chunks);
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(await (await unzip(buffer)).read('word/document.xml')).toContain('Stream');
  });
});
