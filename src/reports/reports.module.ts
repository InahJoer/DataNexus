import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DataEngineModule } from '../data-engine/data-engine.module.js';
import { MailerModule } from '../mailer/mailer.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DataEngineModule,
    MailerModule,
    AuditModule,
    PrismaModule,
    AuthModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
