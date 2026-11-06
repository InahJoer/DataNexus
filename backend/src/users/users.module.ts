import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { InvitationsService } from './invitations.service.js';
import { AcceptInvitationController } from './accept-invitation.controller.js';

@Module({
  imports: [AuthModule, AuditModule, PrismaModule],
  controllers: [UsersController, AcceptInvitationController],
  providers: [UsersService, InvitationsService],
  exports: [UsersService, InvitationsService],
})
export class UsersModule {}
