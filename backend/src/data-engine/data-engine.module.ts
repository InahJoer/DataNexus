import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CommonModule } from '../common/common.module.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { DataEngineController } from './data-engine.controller.js';
import { DataEngineService } from './data-engine.service.js';
import { ADAPTER_PROVIDERS } from './adapters/adapter-providers.js';
import { DataSourcePoolModule } from './pool/data-source-pool.module.js';
import { MaskingService } from './masking/masking.service.js';
import { ExportService } from './export/export.service.js';
import { JoinJobsController } from './jobs/join-jobs.controller.js';
import { JoinJobsService } from './jobs/join-jobs.service.js';

@Module({
  imports: [AuthModule, CommonModule, ConnectionsModule, AuditModule, DataSourcePoolModule],
  controllers: [DataEngineController, JoinJobsController],
  providers: [DataEngineService, MaskingService, ExportService, JoinJobsService, ...ADAPTER_PROVIDERS],
  exports: [DataEngineService, MaskingService, ExportService],
})
export class DataEngineModule {}
