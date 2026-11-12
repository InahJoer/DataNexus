import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { CommonModule } from './common/common.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConnectionsModule } from './connections/connections.module.js';
import { UsersModule } from './users/users.module.js';
import { DataEngineModule } from './data-engine/data-engine.module.js';
import { ExcelSourcesModule } from './excel-sources/excel-sources.module.js';
import { AuditModule } from './audit/audit.module.js';
import { MailerModule } from './mailer/mailer.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { QueriesModule } from './queries/queries.module.js';
import { UsageModule } from './usage/usage.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { HealthModule } from './health/health.module.js';
import { hasNamedThrottle } from './common/named-throttle.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        // Peticiones por minuto e IP (issue #6). Configurable para entornos de carga o pruebas e2e.
        limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 100),
      },
      {
        name: 'export',
        ttl: 60000,
        limit: 20,
        // Un throttler con nombre se aplica a todas las rutas: sin esto, toda la API quedaba limitada a
        // 20 peticiones/min por IP. Solo cuenta en las rutas marcadas con @Throttle({ export: ... }) (issue #52).
        skipIf: (context) => !hasNamedThrottle(context, 'export'),
      },
    ]),
    PrismaModule,
    CommonModule,
    AuthModule,
    ConnectionsModule,
    UsersModule,
    DataEngineModule,
    ExcelSourcesModule,
    AuditModule,
    MailerModule,
    ReportsModule,
    WorkspacesModule,
    QueriesModule,
    UsageModule,
    DashboardModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
