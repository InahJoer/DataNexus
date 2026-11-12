import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import { HealthIndicators } from './health.indicators.js';

/** Endpoints /health y /health/ready (issue #51). PrismaModule y MailerModule son globales. */
@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: 'json' })],
  controllers: [HealthController],
  providers: [HealthIndicators],
})
export class HealthModule {}
