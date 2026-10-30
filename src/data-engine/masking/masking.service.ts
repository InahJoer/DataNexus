import { Injectable, Logger } from '@nestjs/common';

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
   * Enmascara el conjunto de datos si el rol del usuario es 'LECTOR'.
   * Si es ADMIN o cualquier otro rol privilegiado, devuelve los datos íntegros.
   */
  maskDataset(
    records: Record<string, any>[],
    role?: string,
  ): Record<string, any>[] {
    if (!role || role.toUpperCase() !== 'LECTOR') {
      return records;
    }

    this.logger.debug(
      `Aplicando enmascaramiento de datos para usuario con rol '${role}' sobre ${records.length} registros`,
    );

    return records.map((record) => this.maskRecordForRole(record, role));
  }

  maskRecordForRole(
    record: Record<string, any>,
    role?: string,
  ): Record<string, any> {
    if (!role || role.toUpperCase() !== 'LECTOR') return record;
    return this.maskRecord(record);
  }

  isValueMasked(key: string, value: any, role?: string): boolean {
    if (
      !role ||
      role.toUpperCase() !== 'LECTOR' ||
      value === null ||
      value === undefined
    ) {
      return false;
    }
    return this.maskValue(key, value) !== value;
  }

  private maskRecord(record: Record<string, any>): Record<string, any> {
    if (!record || typeof record !== 'object') return record;

    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => {
        if (value === null || value === undefined) return [key, value];
        if (
          typeof value === 'object' &&
          !Array.isArray(value) &&
          !(value instanceof Date)
        ) {
          return [key, this.maskRecord(value)];
        }
        return [key, this.maskValue(key, value)];
      }),
    );
  }

  private maskValue(key: string, value: any): any {
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

  private maskEmail(email: string): string {
    const parts = email.split('@');
    if (parts.length !== 2) return '***@empresa.com';
    const [, domain] = parts;
    return `***@${domain}`;
  }
}
