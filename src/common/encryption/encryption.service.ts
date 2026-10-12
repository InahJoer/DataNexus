import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';

@Injectable()
export class EncryptionService {
  private readonly algorithm = 'aes-256-cbc';
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const rawKey = this.configService.get<string>('ENCRYPTION_KEY') ?? process.env.ENCRYPTION_KEY;
    if (!rawKey) {
      throw new InternalServerErrorException('ENCRYPTION_KEY environment variable is not defined');
    }

    // Soporta clave en formato hexadecimal de 64 caracteres (32 bytes)
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      this.key = Buffer.from(rawKey, 'hex');
    } else {
      const buffer = Buffer.from(rawKey, 'utf8');
      // Si tiene exactamente 32 bytes en UTF-8
      if (buffer.length === 32) {
        this.key = buffer;
      } else {
        // Derivación determinista a 32 bytes (256 bits) usando SHA-256
        this.key = crypto.createHash('sha256').update(rawKey).digest();
      }
    }
  }

  /**
   * Encripta una cadena de texto en claro usando AES-256-CBC.
   * Genera un Vector de Inicialización (IV) criptográficamente seguro de 16 bytes por cada operación.
   * @param text Texto plano a encriptar
   * @returns Cadena con formato "iv_hex:contenido_encriptado_hex"
   */
  encrypt(text: string): string {
    if (text === undefined || text === null) {
      throw new BadRequestException('El texto a encriptar no puede ser nulo o indefinido');
    }

    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return `${iv.toString('hex')}:${encrypted}`;
    } catch (error: any) {
      throw new InternalServerErrorException(`Fallo en el proceso de encriptación: ${error.message}`);
    }
  }

  /**
   * Desencripta un texto previamente encriptado con formato "iv_hex:contenido_encriptado_hex".
   * @param encryptedText Texto encriptado
   * @returns Texto plano desencriptado
   */
  decrypt(encryptedText: string): string {
    if (!encryptedText) {
      throw new BadRequestException('El texto encriptado no puede estar vacío');
    }

    const parts = encryptedText.split(':');
    if (parts.length !== 2) {
      throw new BadRequestException('Formato de texto encriptado inválido. Se espera iv:contenido');
    }

    try {
      const [ivHex, encryptedDataHex] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      if (iv.length !== 16) {
        throw new BadRequestException('Longitud de IV inválida para AES-256-CBC');
      }

      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      let decrypted = decipher.update(encryptedDataHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error: any) {
      throw new InternalServerErrorException(`Fallo en el proceso de desencriptación: ${error.message}`);
    }
  }
}
