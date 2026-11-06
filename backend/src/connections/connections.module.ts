import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CommonModule } from '../common/common.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DataSourcePoolModule } from '../data-engine/pool/data-source-pool.module.js';
import { ConnectionTestService } from './connection-test.service.js';
import { CONNECTION_TESTER_FACTORY } from './testing/connection-tester.interface.js';
import { createConnectionTester } from './testing/connection-tester.factory.js';

@Module({
  imports: [PrismaModule, CommonModule, AuthModule, AuditModule, DataSourcePoolModule],
  controllers: [ConnectionsController],
  providers: [
    ConnectionsService,
    ConnectionTestService,
    { provide: CONNECTION_TESTER_FACTORY, useValue: createConnectionTester },
  ],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
