import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { EncryptionService } from '../../common/encryption/encryption.service.js';
import type {
  DataExtractorAdapter,
  EncryptedConnectionInfo,
} from './data-extractor.adapter.js';
import {
  EXTERNAL_QUERY_TIMEOUT_MS,
  getJsonByteLength,
  getMaxSourceBytes,
  getMaxSourceRows,
} from '../data-engine.constants.js';

interface FirestoreServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

export class FirestoreDataExtractor implements DataExtractorAdapter {
  private readonly maxRows: number;

  constructor(
    private readonly encryptionService: EncryptionService,
    maxRows = getMaxSourceRows(),
    private readonly maxBytes = getMaxSourceBytes(),
  ) {
    this.maxRows = maxRows;
  }

  async extract(
    connection: EncryptedConnectionInfo,
    collectionName: string,
  ): Promise<Record<string, any>[]> {
    this.validateCollectionName(collectionName);
    const account = this.parseServiceAccount(
      this.encryptionService.decrypt(connection.encryptedConnectionString),
    );
    const app = initializeApp(
      {
        projectId: account.project_id,
        credential: cert({
          projectId: account.project_id,
          clientEmail: account.client_email,
          privateKey: account.private_key,
        }),
      },
      `datanexus-${connection.id}-${randomUUID()}`,
    );

    let firestore: ReturnType<typeof getFirestore> | undefined;
    try {
      firestore =
        connection.dbName && connection.dbName !== '(default)'
          ? getFirestore(app, connection.dbName)
          : getFirestore(app);

      const query = firestore
        .collection(collectionName)
        .limit(this.maxRows + 1);
      const stream = query.stream() as NodeJS.ReadableStream & {
        destroy(error?: Error): unknown;
      };
      const timeout = setTimeout(
        () => stream.destroy(new Error('Firestore query timeout')),
        EXTERNAL_QUERY_TIMEOUT_MS,
      );

      try {
        const rows: Record<string, any>[] = [];
        let totalBytes = 0;

        for await (const document of stream as AsyncIterable<any>) {
          const data = this.normalizeValue(document.data()) as Record<
            string,
            any
          >;
          if (rows.length >= this.maxRows) {
            throw new PayloadTooLargeException(
              `La colección supera el máximo de ${this.maxRows} documentos configurado`,
            );
          }
          const documentIdKey = this.uniqueMetadataKey(data, '__documentId');
          const row = { ...data, [documentIdKey]: document.id };
          const rowBytes = getJsonByteLength(row);
          if (totalBytes + rowBytes > this.maxBytes) {
            throw new PayloadTooLargeException(
              `La colección supera el máximo de ${this.maxBytes} bytes configurado`,
            );
          }
          totalBytes += rowBytes;
          rows.push(row);
        }

        return rows;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      if (firestore) await firestore.terminate().catch(() => undefined);
      await deleteApp(app).catch(() => undefined);
    }
  }

  private parseServiceAccount(
    connectionString: string,
  ): FirestoreServiceAccount {
    let account: unknown;
    try {
      account = JSON.parse(connectionString);
    } catch {
      throw new BadRequestException(
        'La credencial de Firestore debe ser JSON válido',
      );
    }

    if (
      typeof account !== 'object' ||
      account === null ||
      Array.isArray(account)
    ) {
      throw new BadRequestException(
        'La credencial de Firestore debe ser un objeto de cuenta de servicio',
      );
    }

    const serviceAccount = account as FirestoreServiceAccount;
    if (
      typeof serviceAccount.project_id !== 'string' ||
      !serviceAccount.project_id.trim() ||
      typeof serviceAccount.client_email !== 'string' ||
      !serviceAccount.client_email.trim() ||
      typeof serviceAccount.private_key !== 'string' ||
      !serviceAccount.private_key.trim()
    ) {
      throw new BadRequestException(
        'La cuenta de servicio de Firestore está incompleta',
      );
    }
    return serviceAccount;
  }

  private validateCollectionName(collectionName: string): void {
    if (
      !collectionName ||
      collectionName.length > 150 ||
      collectionName.includes('/')
    ) {
      throw new BadRequestException(
        'Solo se admiten colecciones raíz con nombre válido',
      );
    }
  }

  private uniqueMetadataKey(
    data: Record<string, any>,
    preferredKey: string,
  ): string {
    let key = preferredKey;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(data, key)) {
      key = `${preferredKey}_${suffix}`;
      suffix += 1;
    }
    return key;
  }

  private normalizeValue(value: unknown): any {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array)
      return Buffer.from(value).toString('base64');
    if (Array.isArray(value))
      return value.map((entry) => this.normalizeValue(entry));

    if (typeof value === 'object') {
      const record = value as Record<string, unknown> & {
        toDate?: () => Date;
        toBase64?: () => string;
        path?: string;
        latitude?: number;
        longitude?: number;
        get?: () => unknown;
      };

      if (typeof record.toDate === 'function')
        return record.toDate().toISOString();
      if (typeof record.toBase64 === 'function') return record.toBase64();
      if (typeof record.path === 'string' && typeof record.get === 'function')
        return record.path;
      if (
        typeof record.latitude === 'number' &&
        typeof record.longitude === 'number'
      ) {
        return { latitude: record.latitude, longitude: record.longitude };
      }

      return Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [
          key,
          this.normalizeValue(entry),
        ]),
      );
    }

    return value;
  }
}
