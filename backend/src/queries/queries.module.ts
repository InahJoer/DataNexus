import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DataEngineModule } from '../data-engine/data-engine.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SavedQueriesController } from './saved-queries.controller.js';
import { SavedQueriesService } from './saved-queries.service.js';

/** Consultas guardadas / vistas unificadas del Query Builder (issue #35). */
@Module({
  imports: [PrismaModule, AuthModule, AuditModule, DataEngineModule],
  controllers: [SavedQueriesController],
  providers: [SavedQueriesService],
})
export class QueriesModule {}
