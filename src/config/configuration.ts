import { registerAs } from '@nestjs/config';

import { NodeEnv } from './env.validation';

/** Typed, namespaced config slices so each consumer injects only what it needs. */

export const appConfig = registerAs('app', () => ({
  nodeEnv: (process.env.NODE_ENV ?? NodeEnv.Development) as NodeEnv,
  isProduction: process.env.NODE_ENV === NodeEnv.Production,
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  logPretty: process.env.LOG_PRETTY === 'true',
}));

export const databaseConfig = registerAs('database', () => ({
  host: process.env.DB_HOST!,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME!,
  password: process.env.DB_PASSWORD!,
  database: process.env.DB_NAME!,
  runMigrationsOnBoot: process.env.DB_RUN_MIGRATIONS_ON_BOOT !== 'false',
}));

export const jwtConfig = registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET!,
  issuer: process.env.JWT_ISSUER ?? 'program-capacity-service',
  audience: process.env.JWT_AUDIENCE ?? 'program-capacity-clients',
  expiresInSeconds: parseDurationSeconds(process.env.JWT_EXPIRES_IN ?? '3600s'),
}));

/** Accepts `3600`, `3600s`, `15m`, `2h`, `1d`. */
function parseDurationSeconds(value: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!match) {
    throw new Error(`JWT_EXPIRES_IN is not a valid duration: ${value}`);
  }

  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * multipliers[match[2] ?? 's'];
}

export const kafkaConfig = registerAs('kafka', () => ({
  enabled: process.env.KAFKA_ENABLED !== 'false',
  brokers: (process.env.KAFKA_BROKERS ?? '')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean),
  clientId: process.env.KAFKA_CLIENT_ID ?? 'program-capacity-service',
  consumerGroupId: process.env.KAFKA_CONSUMER_GROUP_ID ?? 'program-capacity-service',
  topics: {
    treasuryEvents: process.env.KAFKA_TOPIC_TREASURY_EVENTS ?? 'treasury.capacity.events.v1',
    treasuryReconciliation:
      process.env.KAFKA_TOPIC_TREASURY_RECONCILIATION ?? 'treasury.capacity.reconciliation.v1',
    capacityChanged: process.env.KAFKA_TOPIC_CAPACITY_CHANGED ?? 'program.capacity.changed.v1',
  },
  dlqSuffix: process.env.KAFKA_DLQ_SUFFIX ?? '.dlq',
  maxProcessingAttempts: Number(process.env.KAFKA_MAX_PROCESSING_ATTEMPTS ?? 3),
  retryBaseDelayMs: Number(process.env.KAFKA_RETRY_BASE_DELAY_MS ?? 200),
}));

export const outboxConfig = registerAs('outbox', () => ({
  enabled: process.env.OUTBOX_ENABLED !== 'false',
  pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000),
  batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 100),
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10),
}));

export const configurations = [appConfig, databaseConfig, jwtConfig, kafkaConfig, outboxConfig];
