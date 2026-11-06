import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DataEngineModule } from '../data-engine/data-engine.module.js';
import { MailerModule } from '../mailer/mailer.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ReportStorageModule } from './storage/report-storage.module.js';
import { QueriesModule } from '../queries/queries.module.js';
import { ReportsController } from './reports.controller.js';
import { ScheduledReportsController } from './scheduled-reports.controller.js';
import { ReportsService } from './reports.service.js';
import { ScheduledReportsService } from './scheduled-reports.service.js';
import { ReportExecutionsService } from './report-executions.service.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DataEngineModule,
    MailerModule,
    AuditModule,
    PrismaModule,
    AuthModule,
    ReportStorageModule,
    QueriesModule,
  ],
  controllers: [ReportsController, ScheduledReportsController],
  providers: [ReportsService, ScheduledReportsService, ReportExecutionsService],
  exports: [ReportsService],
})
export class ReportsModule {}
