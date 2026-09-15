import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { Transform } from 'class-transformer';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

const toInt = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') return value;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : value;
};

/**
 * Every environment variable the service reads, checked once at boot.
 * Starting with a missing JWT secret or a typo'd broker list is worse than
 * refusing to start.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT = 3000;

  @IsString()
  @IsOptional()
  LOG_LEVEL = 'info';

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  LOG_PRETTY = false;

  // --- database -------------------------------------------------------------

  @IsString()
  @IsNotEmpty()
  DB_HOST: string;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  DB_PORT = 5432;

  @IsString()
  @IsNotEmpty()
  DB_USERNAME: string;

  @IsString()
  @IsNotEmpty()
  DB_PASSWORD: string;

  @IsString()
  @IsNotEmpty()
  DB_NAME: string;

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  DB_RUN_MIGRATIONS_ON_BOOT = true;

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  DB_LOGGING = false;

  // --- auth -----------------------------------------------------------------

  @IsString()
  @MinLength(32, {
    message: 'JWT_SECRET must be at least 32 characters to give HS256 adequate entropy',
  })
  JWT_SECRET: string;

  @IsString()
  @IsOptional()
  JWT_ISSUER = 'program-capacity-service';

  @IsString()
  @IsOptional()
  JWT_AUDIENCE = 'program-capacity-clients';

  @IsString()
  @IsOptional()
  JWT_EXPIRES_IN = '3600s';

  // --- kafka ----------------------------------------------------------------

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  KAFKA_ENABLED = true;

  @IsString()
  @IsNotEmpty()
  KAFKA_BROKERS: string;

  @IsString()
  @IsOptional()
  KAFKA_CLIENT_ID = 'program-capacity-service';

  @IsString()
  @IsOptional()
  KAFKA_CONSUMER_GROUP_ID = 'program-capacity-service';

  @IsString()
  @IsOptional()
  KAFKA_TOPIC_TREASURY_EVENTS = 'treasury.capacity.events.v1';

  @IsString()
  @IsOptional()
  KAFKA_TOPIC_TREASURY_RECONCILIATION = 'treasury.capacity.reconciliation.v1';

  @IsString()
  @IsOptional()
  KAFKA_TOPIC_CAPACITY_CHANGED = 'program.capacity.changed.v1';

  @IsString()
  @IsOptional()
  KAFKA_DLQ_SUFFIX = '.dlq';

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  KAFKA_MAX_PROCESSING_ATTEMPTS = 3;

  @Transform(toInt)
  @IsInt()
  @Min(0)
  @IsOptional()
  KAFKA_RETRY_BASE_DELAY_MS = 200;

  // --- outbox ---------------------------------------------------------------

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  OUTBOX_ENABLED = true;

  @Transform(toInt)
  @IsInt()
  @Min(100)
  @IsOptional()
  OUTBOX_POLL_INTERVAL_MS = 1000;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  OUTBOX_BATCH_SIZE = 100;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  OUTBOX_MAX_ATTEMPTS = 10;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, { skipMissingProperties: false, whitelist: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return config;
}
