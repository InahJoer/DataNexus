import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuditService } from './audit.service.js';
import { AuditController } from './audit.controller.js';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule)],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
