import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ApiUsageInterceptor } from './api-usage.interceptor.js';
import { UsageMeterService } from './usage-meter.service.js';

/** Medición de uso por workspace (issue #40). Global para que el motor de datos registre los bytes procesados. */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [UsageMeterService, { provide: APP_INTERCEPTOR, useClass: ApiUsageInterceptor }],
  exports: [UsageMeterService],
})
export class UsageModule {}
