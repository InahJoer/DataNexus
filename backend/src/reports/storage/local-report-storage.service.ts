import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  REPORT_LINK_TTL_MS,
  type LocalReportDownload,
} from './report-storage.interface.js';
import type { ReportStorageAdapter } from './report-storage.interface.js';
import { createReportWriteTarget } from './report-write-target.js';

const REPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_FILENAME_PATTERN = /^datanexus_export_[0-9TZ-]+\.(xlsx|pdf)$/;

@Injectable()
export class LocalReportStorageService implements ReportStorageAdapter {
  private readonly directory: string;

  constructor(private readonly configService: ConfigService) {
    this.directory = resolve(
      this.configService.get<string>('REPORTS_LOCAL_DIRECTORY') ?? 'storage/reports',
    );
  }

  async createWriteTarget(id: string, contentType: string) {
    this.assertReportId(id);
    this.assertContentType(contentType);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });

    const path = join(this.directory, id);
    const file = await open(path, 'wx', 0o600);
    return createReportWriteTarget(file.createWriteStream(), async () => {
      await unlink(path);
    });
  }

  async createDownloadUrl(
    id: string,
    filename: string,
  ): Promise<{ url: string; expiresAt: string }> {
    this.assertReportId(id);
    this.assertFilename(filename);

    const expires = String(Math.floor((Date.now() + REPORT_LINK_TTL_MS) / 1000));
    const signature = this.sign(id, filename, expires);
    const baseUrl =
      this.configService.get<string>('REPORTS_PUBLIC_BASE_URL') ??
      `http://localhost:${this.configService.get<number>('PORT') ?? 3001}`;
    const url = new URL(`reports/download/${id}`, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    url.searchParams.set('filename', filename);
    url.searchParams.set('expires', expires);
    url.searchParams.set('signature', signature);

    return { url: url.toString(), expiresAt: new Date(Number(expires) * 1000).toISOString() };
  }

  async openLocalDownload(
    id: string,
    filename: string,
    expires: string,
    signature: string,
  ): Promise<LocalReportDownload> {
    this.assertReportId(id);
    this.assertFilename(filename);
    this.assertSignature(id, filename, expires, signature);

    const path = join(this.directory, id);
    try {
      await access(path);
    } catch {
      throw new NotFoundException('El reporte no existe o ya no está disponible');
    }

    const contentType = filename.endsWith('.xlsx')
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/pdf';

    return { stream: createReadStream(path), filename, contentType };
  }

  private assertReportId(id: string): void {
    if (!REPORT_ID_PATTERN.test(id)) {
      throw new UnauthorizedException('El enlace de descarga no es válido');
    }
  }

  private assertFilename(filename: string): void {
    if (!REPORT_FILENAME_PATTERN.test(filename)) {
      throw new UnauthorizedException('El enlace de descarga no es válido');
    }
  }

  private assertContentType(contentType: string): void {
    if (
      contentType !== 'application/pdf' &&
      contentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ) {
      throw new Error('Tipo de archivo de reporte no válido');
    }
  }

  private assertSignature(id: string, filename: string, expires: string, signature: string): void {
    if (!/^\d{1,12}$/.test(expires) || !/^[0-9a-f]{64}$/i.test(signature)) {
      throw new UnauthorizedException('El enlace de descarga no es válido');
    }

    const expiresAt = Number(expires) * 1000;
    const now = Date.now();
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + REPORT_LINK_TTL_MS + 1000
    ) {
      throw new UnauthorizedException('El enlace de descarga venció o no es válido');
    }

    const expected = Buffer.from(this.sign(id, filename, expires), 'hex');
    const received = Buffer.from(signature, 'hex');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new UnauthorizedException('El enlace de descarga no es válido');
    }
  }

  private sign(id: string, filename: string, expires: string): string {
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) throw new Error('JWT_SECRET es requerido para firmar los enlaces de reportes');

    return createHmac('sha256', secret).update(`${id}\0${filename}\0${expires}`).digest('hex');
  }
}
