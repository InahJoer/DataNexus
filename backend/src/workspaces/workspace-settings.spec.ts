import { describe, expect, it } from 'vitest';
import {
  isEmailDomainAllowed,
  isValidTimeZone,
  normalizeAllowedDomains,
  normalizeSensitiveFields,
} from './workspace-settings.js';

describe('Configuración del workspace', () => {
  describe('isValidTimeZone', () => {
    it('acepta identificadores IANA', () => {
      for (const tz of ['UTC', 'America/Managua', 'Europe/Madrid', 'America/Argentina/Buenos_Aires']) {
        expect(isValidTimeZone(tz), tz).toBe(true);
      }
    });

    it('rechaza valores que no son zonas horarias', () => {
      for (const tz of ['', '  ', 'Managua', 'America/Atlantida', 42, null, undefined, 'x'.repeat(65)]) {
        expect(isValidTimeZone(tz), String(tz)).toBe(false);
      }
    });
  });

  describe('normalizeAllowedDomains', () => {
    it('pasa a minúsculas, quita "@" y elimina duplicados', () => {
      expect(normalizeAllowedDomains([' Acme.com ', '@acme.com', 'ventas.ACME.com.ni'], {})).toEqual({
        ok: true,
        values: ['acme.com', 'ventas.acme.com.ni'],
      });
    });

    it('acepta una lista vacía (sin restricción)', () => {
      expect(normalizeAllowedDomains([], {})).toEqual({ ok: true, values: [] });
    });

    it('rechaza formatos inválidos', () => {
      const result = normalizeAllowedDomains(['acme', 'acme..com', '-acme.com', 'ac me.com', 'acme.com/x'], {});
      expect(result).toEqual({
        ok: false,
        invalid: ['acme', 'acme..com', '-acme.com', 'ac me.com', 'acme.com/x'],
      });
    });

    it('rechaza proveedores de correo personal porque nunca podrían invitarse', () => {
      expect(normalizeAllowedDomains(['acme.com', 'gmail.com', 'Outlook.com'], {})).toEqual({
        ok: false,
        invalid: ['gmail.com', 'outlook.com'],
      });
    });
  });

  describe('normalizeSensitiveFields', () => {
    it('normaliza y admite rutas anidadas', () => {
      expect(normalizeSensitiveFields(['Cedula', 'cedula', ' cliente.Email ', 'salario_base'])).toEqual({
        ok: true,
        values: ['cedula', 'cliente.email', 'salario_base'],
      });
    });

    it('rechaza nombres vacíos o con caracteres peligrosos', () => {
      const result = normalizeSensitiveFields(['', 'nombre; DROP TABLE x', '1campo', 'a..b']);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.invalid).toEqual(['', 'nombre; drop table x', '1campo', 'a..b']);
    });
  });

  describe('isEmailDomainAllowed', () => {
    it('sin dominios configurados no restringe', () => {
      expect(isEmailDomainAllowed('ana@cualquiera.com', [])).toBe(true);
    });

    it('acepta el dominio exacto y sus subdominios', () => {
      expect(isEmailDomainAllowed('Ana@ACME.com', ['acme.com'])).toBe(true);
      expect(isEmailDomainAllowed('ana@ventas.acme.com', ['acme.com'])).toBe(true);
    });

    it('rechaza dominios ajenos aunque terminen igual', () => {
      expect(isEmailDomainAllowed('ana@notacme.com', ['acme.com'])).toBe(false);
      expect(isEmailDomainAllowed('ana@acme.com.evil.io', ['acme.com'])).toBe(false);
    });
  });
});
