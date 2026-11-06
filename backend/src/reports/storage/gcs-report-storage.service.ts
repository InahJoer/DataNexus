import { Storage } from '@google-cloud/storage';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  REPORT_LINK_TTL_MS,
  type LocalReportDownload,
} from './report-storage.interface.js';
import {
  REPORT_FILENAME_PATTERN,
  isReportContentType,
  type ReportStorageAdapter,
} from './report-storage.interface.js';
import { createReportWriteTarget } from './report-write-target.js';

const REPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class GcsReportStorageService implements ReportStorageAdapter {
  private readonly storage = new Storage();
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.get<string>('REPORTS_GCS_BUCKET') ?? '';
    if (!this.bucketName) throw new Error('REPORTS_GCS_BUCKET es requerido para usar GCS');
  }

  async createWriteTarget(id: string, contentType: string) {
    this.assertReportId(id);
    this.assertContentType(contentType);
    const destination = this.storage
      .bucket(this.bucketName)
      .file(`reports/${id}`)
      .createWriteStream({
        resumable: false,
        metadata: { contentType },
      });
    return createReportWriteTarget(destination);
  }

  async createDownloadUrl(
    id: string,
    filename: string,
  ): Promise<{ url: string; expiresAt: string }> {
    this.assertReportId(id);
    this.assertFilename(filename);

    const expiresAt = Date.now() + REPORT_LINK_TTL_MS;
    const [url] = await this.storage
      .bucket(this.bucketName)
      .file(`reports/${id}`)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: new Date(expiresAt),
        responseDisposition: `attachment; filename="${filename}"`,
      });

    return { url, expiresAt: new Date(expiresAt).toISOString() };
  }

  async openLocalDownload(
    _id: string,
    _filename: string,
    _expires: string,
    _signature: string,
  ): Promise<LocalReportDownload> {
    throw new NotFoundException('La descarga local no está habilitada para el proveedor GCS');
  }

  private assertReportId(id: string): void {
    if (!REPORT_ID_PATTERN.test(id)) throw new BadRequestException('ID de reporte no válido');
  }

  private assertFilename(filename: string): void {
    if (!REPORT_FILENAME_PATTERN.test(filename)) {
      throw new BadRequestException('Nombre de reporte no válido');
    }
  }

  private assertContentType(contentType: string): void {
    if (!isReportContentType(contentType)) {
      throw new BadRequestException('Tipo de archivo de reporte no válido');
    }
  }
}
