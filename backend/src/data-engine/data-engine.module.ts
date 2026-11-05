import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CommonModule } from '../common/common.module.js';
import { EncryptionService } from '../common/encryption/encryption.service.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { DataEngineController } from './data-engine.controller.js';
import { DataEngineService } from './data-engine.service.js';
import {
  DATA_EXPLORER_FACTORY,
  type DataExplorerFactory,
} from './data-explorer.interface.js';
import {
  DATA_EXTRACTOR_FACTORY,
  type DataExtractorFactory,
} from './adapters/data-extractor.adapter.js';
import { FirestoreDataExplorer } from './adapters/firestore-data-explorer.js';
import { FirestoreDataExtractor } from './adapters/firestore-data-extractor.js';
import { MysqlDataExplorer } from './adapters/mysql-data-explorer.js';
import { PostgresDataExplorer } from './adapters/postgres-data-explorer.js';
import { SqlServerDataExplorer } from './adapters/sqlserver-data-explorer.js';
import { SqlServerDataExtractor } from './adapters/sqlserver-data-extractor.js';
import { DataExtractorService } from './adapters/data-extractor.adapter.js';
import {
  getMaxSourceBytes,
  getMaxSourceRows,
} from './data-engine.constants.js';
import { MaskingService } from './masking/masking.service.js';
import { ExportService } from './export/export.service.js';

const createExplorer: DataExplorerFactory = (tipoMotor) => {
  const motor = tipoMotor.toLowerCase().replace(/[^a-z]/g, '');
  if (motor === 'postgres' || motor === 'postgresql')
    return new PostgresDataExplorer();
  if (motor === 'mysql') return new MysqlDataExplorer();
  if (motor === 'sqlserver' || motor === 'mssql')
    return new SqlServerDataExplorer();
  if (
    motor === 'firebase' ||
    motor === 'firestore' ||
    motor === 'cloudfirestore'
  ) {
    return new FirestoreDataExplorer();
  }
  return undefined;
};

const createExtractor = (
  encryptionService: EncryptionService,
): DataExtractorFactory =>
  (tipoMotor) => {
    const motor = tipoMotor.toLowerCase().replace(/[^a-z]/g, '');
    const maxRows = getMaxSourceRows();
    const maxBytes = getMaxSourceBytes();
    if (motor === 'sqlserver' || motor === 'mssql')
      return new SqlServerDataExtractor(
        encryptionService,
        maxRows,
        maxBytes,
      );
    if (
      motor === 'firebase' ||
      motor === 'firestore' ||
      motor === 'cloudfirestore'
    ) {
      return new FirestoreDataExtractor(
        encryptionService,
        maxRows,
        maxBytes,
      );
    }
    return undefined;
  };

@Module({
  imports: [AuthModule, CommonModule, ConnectionsModule],
  controllers: [DataEngineController],
  providers: [
    DataEngineService,
    DataExtractorService,
    MaskingService,
    ExportService,
    { provide: DATA_EXPLORER_FACTORY, useValue: createExplorer },
    {
      provide: DATA_EXTRACTOR_FACTORY,
      inject: [EncryptionService],
      useFactory: createExtractor,
    },
  ],
  exports: [DataEngineService, MaskingService, ExportService],
})
export class DataEngineModule {}
