import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DataRetentionService } from './data-retention.service.js';

/** Tareas de mantenimiento de la base interna (retención de datos). */
@Module({
  imports: [PrismaModule],
  providers: [DataRetentionService],
  exports: [DataRetentionService],
})
export class MaintenanceModule {}
