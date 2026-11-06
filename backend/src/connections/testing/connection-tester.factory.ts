import type { ConnectionTesterFactory } from './connection-tester.interface.js';
import { FirestoreConnectionTester } from './firestore-connection-tester.js';
import { MysqlConnectionTester } from './mysql-connection-tester.js';
import { PostgresConnectionTester } from './postgres-connection-tester.js';
import { SqlServerConnectionTester } from './sqlserver-connection-tester.js';

export const createConnectionTester: ConnectionTesterFactory = (tipoMotor) => {
  const motor = tipoMotor.toLowerCase().replace(/[^a-z]/g, '');
  if (motor === 'postgres' || motor === 'postgresql') return new PostgresConnectionTester();
  if (motor === 'mysql' || motor === 'mariadb') return new MysqlConnectionTester();
  if (motor === 'sqlserver' || motor === 'mssql') return new SqlServerConnectionTester();
  if (motor === 'firestore' || motor === 'firebase' || motor === 'cloudfirestore') {
    return new FirestoreConnectionTester();
  }
  return undefined;
};
