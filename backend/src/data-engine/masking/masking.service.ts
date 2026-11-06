import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { hasPermission } from '../../auth/interfaces/user-role.js';

export type MaskingStrategy = 'EMAIL' | 'PHONE' | 'FULL' | 'HASH';

/** Campo configurado como sensible (RF-20). `campo` en minúsculas. */
export interface SensitiveRule {
  campo: string;
  estrategia: MaskingStrategy;
}

/** Busca la regla de una columna: por nombre exacto o calificado con el alias de la fuente (`clientes.email`). */
export function findRule(key: string, rules: readonly SensitiveRule[] | undefined): SensitiveRule | undefined {
  if (!rules?.length) return undefined;
  const lower = key.toLowerCase();
  return rules.find((rule) => lower === rule.campo || lower.endsWith(`.${rule.campo}`));
}

@Injectable()
export class MaskingService {
  private readonly logger = new Logger(MaskingService.name);

  private readonly EMAIL_REGEX = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;
  private readonly PHONE_KEYS = [
    'telefono',
    'celular',
    'phone',
    'tel',
    'telefono_contacto',
  ];
  private readonly SECRET_KEYS = [
    'password',
    'contrasena',
    'secret',
    'token',
    'apikey',
    'key',
  ];

  /**
   * Enmascara el conjunto de datos salvo que el rol tenga el permiso VIEW_UNMASKED_DATA
   * (ADMIN u OPERADOR). Política fail-closed: LECTOR, AUDITOR o un rol desconocido
   * siempre reciben los datos enmascarados.
   */
  maskDataset(
    records: Record<string, any>[],
    role?: string,
    rules?: readonly SensitiveRule[],
  ): Record<string, any>[] {
    if (this.canViewUnmasked(role)) {
      return records;
    }

    this.logger.debug(
      `Aplicando enmascaramiento de datos para usuario con rol '${role}' sobre ${records.length} registros`,
    );

    return records.map((record) => this.maskRecordForRole(record, role, rules));
  }

  maskRecordForRole(
    record: Record<string, any>,
    role?: string,
    rules?: readonly SensitiveRule[],
  ): Record<string, any> {
    if (this.canViewUnmasked(role)) return record;
    return this.maskRecord(record, rules);
  }

  isValueMasked(key: string, value: any, role?: string, rules?: readonly SensitiveRule[]): boolean {
    if (
      this.canViewUnmasked(role) ||
      value === null ||
      value === undefined
    ) {
      return false;
    }
    return this.maskValue(key, value, rules) !== value;
  }

  private canViewUnmasked(role?: string): boolean {
    return hasPermission(role, 'VIEW_UNMASKED_DATA');
  }

  private maskRecord(record: Record<string, any>, rules?: readonly SensitiveRule[]): Record<string, any> {
    if (!record || typeof record !== 'object') return record;

    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => {
        if (value === null || value === undefined) return [key, value];
        // Un campo configurado como sensible se enmascara entero, aunque sea un objeto o una lista.
        const rule = findRule(key, rules);
        if (rule) return [key, this.applyStrategy(rule.estrategia, value)];
        if (
          typeof value === 'object' &&
          !Array.isArray(value) &&
          !(value instanceof Date)
        ) {
          return [key, this.maskRecord(value, rules)];
        }
        return [key, this.maskValue(key, value, rules)];
      }),
    );
  }

  private maskValue(key: string, value: any, rules?: readonly SensitiveRule[]): any {
    // 0. Configuración del workspace (RF-20): tiene prioridad sobre las heurísticas.
    const rule = findRule(key, rules);
    if (rule) return this.applyStrategy(rule.estrategia, value);

    const lowerKey = key.toLowerCase();

    // 1. Password o secretos
    if (this.SECRET_KEYS.some((s) => lowerKey.includes(s))) {
      return '********';
    }

    // 2. Teléfonos
    if (this.PHONE_KEYS.some((p) => lowerKey.includes(p))) {
      return '********';
    }

    // 3. Emails
    if (typeof value === 'string') {
      if (
        lowerKey.includes('email') ||
        lowerKey.includes('correo') ||
        this.EMAIL_REGEX.test(value)
      ) {
        return this.maskEmail(value);
      }
    }

    return value;
  }

  /**
   * EMAIL: conserva solo el dominio. PHONE: conserva los 2 últimos dígitos. FULL: oculta todo. HASH: huella
   * HMAC-SHA256 estable (permite agrupar y contar sin revelar el valor; no se puede revertir sin la clave).
   */
  private applyStrategy(strategy: MaskingStrategy, value: unknown): string {
    if (value === null || value === undefined) return '********';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value as string | number | boolean | bigint);
    switch (strategy) {
      case 'EMAIL':
        return this.maskEmail(text);
      case 'PHONE': {
        const digits = text.replace(/\D/g, '');
        return digits.length > 4 ? `******${digits.slice(-2)}` : '********';
      }
      case 'HASH':
        return `hash:${createHmac('sha256', process.env.ENCRYPTION_KEY ?? 'datanexus-masking').update(text, 'utf8').digest('hex').slice(0, 16)}`;
      default:
        return '********';
    }
  }

  private maskEmail(email: string): string {
    const parts = email.split('@');
    if (parts.length !== 2) return '***@empresa.com';
    const [, domain] = parts;
    return `***@${domain}`;
  }
}
