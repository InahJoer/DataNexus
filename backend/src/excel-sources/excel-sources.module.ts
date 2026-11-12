import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ExcelSheetStore } from './excel-sheet-store.js';
import { ExcelSourcesController } from './excel-sources.controller.js';
import { ExcelSourcesService } from './excel-sources.service.js';

/** Archivos de Excel como fuente de datos. DataEngineModule usa ExcelSheetStore desde el adaptador EXCEL. */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ExcelSourcesController],
  providers: [ExcelSourcesService, ExcelSheetStore],
  exports: [ExcelSheetStore],
})
export class ExcelSourcesModule {}
