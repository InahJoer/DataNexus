import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { CommonModule } from './common/common.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConnectionsModule } from './connections/connections.module.js';
import { UsersModule } from './users/users.module.js';
import { DataEngineModule } from './data-engine/data-engine.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    CommonModule,
    AuthModule,
    ConnectionsModule,
    UsersModule,
    DataEngineModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
