import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CommonModule } from '../common/common.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [PrismaModule, CommonModule, AuthModule, AuditModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
