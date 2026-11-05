import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GcsReportStorageService } from './gcs-report-storage.service.js';
import { LocalReportStorageService } from './local-report-storage.service.js';
import { REPORT_STORAGE_ADAPTER, type ReportStorageAdapter } from './report-storage.interface.js';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REPORT_STORAGE_ADAPTER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): ReportStorageAdapter => {
        const provider = configService.get<string>('REPORT_STORAGE_PROVIDER') ?? 'local';
        if (provider === 'gcs') return new GcsReportStorageService(configService);
        return new LocalReportStorageService(configService);
      },
    },
  ],
  exports: [REPORT_STORAGE_ADAPTER],
})
export class ReportStorageModule {}
