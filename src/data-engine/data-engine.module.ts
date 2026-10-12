import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { DataEngineController } from './data-engine.controller.js';
import { DataEngineService } from './data-engine.service.js';
import { DATA_EXPLORER_FACTORY, type DataExplorerFactory } from './data-explorer.interface.js';
import { FirestoreDataExplorer } from './adapters/firestore-data-explorer.js';
import { MysqlDataExplorer } from './adapters/mysql-data-explorer.js';
import { PostgresDataExplorer } from './adapters/postgres-data-explorer.js';
import { SqlServerDataExplorer } from './adapters/sqlserver-data-explorer.js';

const createExplorer: DataExplorerFactory = (tipoMotor) => {
  const motor = tipoMotor.toLowerCase().replace(/[^a-z]/g, '');
  if (motor === 'postgres' || motor === 'postgresql') return new PostgresDataExplorer();
  if (motor === 'mysql') return new MysqlDataExplorer();
  if (motor === 'sqlserver' || motor === 'mssql') return new SqlServerDataExplorer();
  if (motor === 'firebase' || motor === 'firestore' || motor === 'cloudfirestore') {
    return new FirestoreDataExplorer();
  }
  return undefined;
};

@Module({
  imports: [AuthModule, ConnectionsModule],
  controllers: [DataEngineController],
  providers: [
    DataEngineService,
    { provide: DATA_EXPLORER_FACTORY, useValue: createExplorer },
  ],
})
export class DataEngineModule {}
