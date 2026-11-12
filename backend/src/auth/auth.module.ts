import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { AuthService } from './auth.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { SessionsService } from './sessions.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { RolesGuard } from './guards/roles.guard.js';
import { getJwtSecret } from './jwt-secret.js';
import { AuditModule } from '../audit/audit.module.js';
import { PersonalAccessTokensController } from './pat/personal-access-tokens.controller.js';
import { PersonalAccessTokensService } from './pat/personal-access-tokens.service.js';

@Module({
  imports: [
    forwardRef(() => AuditModule),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: getJwtSecret(configService),
        signOptions: {
          expiresIn: (configService.get<string>('JWT_EXPIRES_IN') ?? '15m') as any,
        },
      }),
    }),
  ],
  controllers: [AuthController, AccountController, PersonalAccessTokensController],
  providers: [
    AuthService,
    AccountService,
    SessionsService,
    PasswordResetService,
    PersonalAccessTokensService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [AuthService, SessionsService, PersonalAccessTokensService, JwtAuthGuard, RolesGuard, PassportModule, JwtModule],
})
export class AuthModule {}
