import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service.js';

describe('EncryptionService', () => {
  let service: EncryptionService;
  const mockConfigService = {
    get: (key: string) => {
      if (key === 'ENCRYPTION_KEY') {
        return '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      }
      return null;
    },
  } as unknown as ConfigService;

  beforeEach(() => {
    service = new EncryptionService(mockConfigService);
  });

  it('debe estar definido', () => {
    expect(service).toBeDefined();
  });

  it('debe encriptar y desencriptar un texto plano retornando el valor original (AES-256-CBC)', () => {
    const rawConnectionString =
      'Server=192.168.1.100;Database=DataNexusProd;User Id=sa;Password=SuperSecretPass!2026;';

    const encrypted = service.encrypt(rawConnectionString);

    expect(encrypted).toBeDefined();
    expect(encrypted).not.toEqual(rawConnectionString);
    expect(encrypted).toContain(':'); // formato iv:contenido

    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toEqual(rawConnectionString);
  });

  it('debe generar diferentes textos cifrados para el mismo texto gracias al IV aleatorio', () => {
    const raw = 'Password123!';
    const encrypted1 = service.encrypt(raw);
    const encrypted2 = service.encrypt(raw);

    expect(encrypted1).not.toEqual(encrypted2);
    expect(service.decrypt(encrypted1)).toEqual(raw);
    expect(service.decrypt(encrypted2)).toEqual(raw);
  });

  it('debe arrojar error si el formato del texto encriptado es inválido', () => {
    expect(() => service.decrypt('texto-sin-iv')).toThrow();
  });
});
