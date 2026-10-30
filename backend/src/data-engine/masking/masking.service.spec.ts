import { describe, expect, it } from 'vitest';
import { MaskingService } from './masking.service.js';

describe('MaskingService', () => {
  const service = new MaskingService();

  const sampleData = [
    {
      id: 'cli_1',
      cliente_id: 'cli_1',
      nombre: 'Empresa Alfa',
      email: 'juan.perez@empresa.com',
      telefono: '+54 11 5566-7788',
      password_hash: 'secret_hash_123',
      saldo: '1500.50',
    },
  ];

  it('masks emails, phones and secrets when role is LECTOR', () => {
    const masked = service.maskDataset(sampleData, 'LECTOR');

    expect(masked).toHaveLength(1);
    expect(masked[0].nombre).toBe('Empresa Alfa');
    expect(masked[0].saldo).toBe('1500.50');
    // Enmascarados
    expect(masked[0].email).toBe('***@empresa.com');
    expect(masked[0].telefono).toBe('********');
    expect(masked[0].password_hash).toBe('********');
  });

  it('preserves clean original data when role is ADMIN', () => {
    const unmasked = service.maskDataset(sampleData, 'ADMIN');

    expect(unmasked).toHaveLength(1);
    expect(unmasked[0].email).toBe('juan.perez@empresa.com');
    expect(unmasked[0].telefono).toBe('+54 11 5566-7788');
    expect(unmasked[0].password_hash).toBe('secret_hash_123');
  });

  it('handles empty datasets or invalid inputs gracefully', () => {
    expect(service.maskDataset([], 'LECTOR')).toEqual([]);
    expect(service.maskDataset(sampleData, undefined)).toEqual(sampleData);
  });
});
