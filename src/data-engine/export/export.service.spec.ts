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
