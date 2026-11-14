import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ExcelSheetStore } from './excel-sheet-store.js';
import { ExcelSourcesController } from './excel-sources.controller.js';
import { ExcelSourcesService } from './excel-sources.service.js';
import { ExcelTableStore } from './excel-table-store.js';

/** Archivos de Excel como fuente de datos. DataEngineModule usa ExcelSheetStore y ExcelTableStore desde el adaptador EXCEL. */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ExcelSourcesController],
  providers: [ExcelSourcesService, ExcelSheetStore, ExcelTableStore],
  exports: [ExcelSheetStore, ExcelTableStore],
})
export class ExcelSourcesModule {}
