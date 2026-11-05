import { plainToInstance, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/** Valores de ejemplo publicados en .env.example que nunca deben usarse en producción. */
const EXAMPLE_VALUES: Record<'JWT_SECRET' | 'ENCRYPTION_KEY', (value: string) => boolean> = {
  JWT_SECRET: (value) => value.includes('cambia-esto'),
  ENCRYPTION_KEY: (value) =>
    value.toLowerCase() === '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

/**
 * Variables de entorno requeridas y opcionales del backend.
 * Se validan al arrancar: si falta algo crítico la aplicación no inicia.
 */
export class EnvironmentVariables {
  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsString()
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message: 'DATABASE_URL debe ser una URL de PostgreSQL (postgresql://usuario:clave@host:5432/base)',
  })
  DATABASE_URL: string;

  @IsString()
  @MinLength(32, { message: 'JWT_SECRET debe tener al menos 32 caracteres' })
  JWT_SECRET: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+[smhd]?$/, { message: 'JWT_EXPIRES_IN debe tener el formato 15m, 1h o 1d' })
  JWT_EXPIRES_IN?: string;

  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'ENCRYPTION_KEY debe ser una clave hexadecimal de 64 caracteres (32 bytes)',
  })
  ENCRYPTION_KEY: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  @IsOptional()
  @IsUrl({ require_tld: false })
  FRONTEND_URL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SMTP_HOST?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT?: number;

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASS?: string;

  @IsOptional()
  @IsString()
  MAIL_FROM?: string;

  @IsOptional()
  @IsEmail()
  SEED_ADMIN_EMAIL?: string;

  /** Minutos de validez del enlace de recuperación de contraseña (por defecto 30). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  PASSWORD_RESET_TTL_MINUTES?: number;

  /** Minutos sin actividad tras los que se cierra la sesión (RF-04, por defecto 30). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  SESSION_IDLE_TIMEOUT_MINUTES?: number;

  /** Días de vida máxima de una sesión aunque haya actividad (por defecto 7). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  REFRESH_TOKEN_TTL_DAYS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  DATA_ENGINE_MAX_SOURCE_ROWS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  DATA_ENGINE_MAX_JOIN_ROWS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  DATA_ENGINE_MAX_SOURCE_BYTES?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  DATA_ENGINE_MAX_JOIN_BYTES?: number;
}

/**
 * Función `validate` para ConfigModule.forRoot.
 * Lanza un único error con todos los problemas encontrados, en español.
 */
export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  // Una variable vacía (`SMTP_HOST=`) equivale a no definida.
  const normalized = Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, value === '' ? undefined : value]),
  );
  const env = plainToInstance(EnvironmentVariables, normalized, { enableImplicitConversion: false });
  const errors = validateSync(env, { skipMissingProperties: false, whitelist: false });

  const problems = errors.flatMap((error) =>
    Object.values(error.constraints ?? {}).map((message) => `  - ${error.property}: ${message}`),
  );

  if (env.NODE_ENV === 'production') {
    for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY'] as const) {
      if (EXAMPLE_VALUES[key](String(config[key] ?? ''))) {
        problems.push(`  - ${key}: usa el valor de ejemplo de .env.example; genera uno propio`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Configuración de entorno inválida. Revisa tu archivo .env:\n${problems.join('\n')}`,
    );
  }

  return env;
}
