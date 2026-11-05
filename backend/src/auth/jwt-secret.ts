import { ConfigService } from '@nestjs/config';

export function getJwtSecret(configService: ConfigService): string {
  const secret = configService.getOrThrow<string>('JWT_SECRET');
  if (secret.length < 32) {
    throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
  }
  return secret;
}
