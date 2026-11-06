import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { PlatformHealthService } from './platform-health.service.js';

/** Vista general de Operaciones (issue #40). */
@Module({
  imports: [PrismaModule, AuthModule, ReportsModule],
  controllers: [DashboardController],
  providers: [DashboardService, PlatformHealthService],
})
export class DashboardModule {}
