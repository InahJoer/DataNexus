import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class MaskingService {
  private readonly logger = new Logger(MaskingService.name);

  private readonly EMAIL_REGEX = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;
  private readonly PHONE_KEYS = ['telefono', 'celular', 'phone', 'tel', 'telefono_contacto'];
  private readonly SECRET_KEYS = ['password', 'contrasena', 'secret', 'token', 'apikey', 'key'];

  /**
   * Enmascara el conjunto de datos si el rol del usuario es 'LECTOR'.
   * Si es ADMIN o cualquier otro rol privilegiado, devuelve los datos íntegros.
   */
  maskDataset(records: Record<string, any>[], role?: string): Record<string, any>[] {
    if (!role || role.toUpperCase() !== 'LECTOR') {
      return records;
    }

    this.logger.debug(
      `Aplicando enmascaramiento de datos para usuario con rol '${role}' sobre ${records.length} registros`,
    );

    return records.map((record) => this.maskRecord(record));
  }

  private maskRecord(record: Record<string, any>): Record<string, any> {
    if (!record || typeof record !== 'object') return record;

    const masked: Record<string, any> = {};

    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === undefined) {
        masked[key] = value;
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        masked[key] = this.maskRecord(value);
        continue;
      }

      masked[key] = this.maskValue(key, value);
    }

    return masked;
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
      if (lowerKey.includes('email') || lowerKey.includes('correo') || this.EMAIL_REGEX.test(value)) {
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
