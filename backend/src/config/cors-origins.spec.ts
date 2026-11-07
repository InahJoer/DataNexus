import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from './cors-origins.js';

const configured = ['http://localhost:3000', 'https://app.datanexus.io'];

describe('isAllowedOrigin (CORS)', () => {
  it('acepta peticiones sin Origin y los orígenes configurados en cualquier entorno', () => {
    expect(isAllowedOrigin(undefined, configured, true)).toBe(true);
    expect(isAllowedOrigin('https://app.datanexus.io', configured, true)).toBe(true);
  });

  it('en desarrollo acepta localhost y las IP de redes privadas en cualquier puerto', () => {
    for (const origin of ['http://192.168.1.18:3000', 'http://10.0.0.5:3000', 'http://172.20.1.2:5173', 'http://127.0.0.1:4000', 'http://localhost:8080']) {
      expect(isAllowedOrigin(origin, configured, false)).toBe(true);
    }
  });

  it('rechaza dominios públicos e IP que no son privadas, aunque se parezcan', () => {
    for (const origin of ['https://evil.com', 'http://8.8.8.8:3000', 'http://172.32.0.1:3000', 'http://192.168.1.18.evil.com', 'file://', 'null']) {
      expect(isAllowedOrigin(origin, configured, false)).toBe(false);
    }
  });

  it('en producción solo cuentan los orígenes configurados', () => {
    expect(isAllowedOrigin('http://192.168.1.18:3000', configured, true)).toBe(false);
  });
});
