import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';

import { UserEntity, UserRole } from '../../src/auth/user.entity';
import { Money } from '../../src/common/money';
import { FxRateEntity } from '../../src/fx/fx-rate.entity';
import { userActor } from '../../src/ledger/ledger-actor';
import { ProgramEntity } from '../../src/programs/program.entity';

/** Stands in for the authenticated caller when a test drives a service directly. */
export const TEST_ACTOR = userActor('00000000-0000-4000-8000-000000000001', 'test@local');

export interface TestContext {
  app: INestApplication;
  dataSource: DataSource;

  close(): Promise<void>;

  reset(): Promise<void>;

  createProgram(code: string, limit: string, currency: string): Promise<ProgramEntity>;

  tokenFor(role: UserRole): Promise<string>;
}

const PASSWORD = 'Password123!';

/**
 * Boots the real application against a throwaway PostgreSQL container.
 *
 * Kafka is switched off: the broker adds start-up time and flakiness without
 * covering anything these suites assert. Message handling is exercised by
 * calling the consumer's `processMessage` directly, which runs the same
 * deduplication and transaction path that `eachMessage` does.
 */
export async function createTestContext(): Promise<TestContext> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('capacity_test')
    .withUsername('capacity')
    .withPassword('capacity')
    .start();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_HOST: container.getHost(),
    DB_PORT: String(container.getPort()),
    DB_USERNAME: container.getUsername(),
    DB_PASSWORD: container.getPassword(),
    DB_NAME: container.getDatabase(),
    DB_RUN_MIGRATIONS_ON_BOOT: 'true',
    DB_LOGGING: 'false',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
    JWT_SECRET: 'integration-test-secret-that-is-long-enough',
    KAFKA_ENABLED: 'false',
    KAFKA_BROKERS: 'localhost:19092',
    OUTBOX_ENABLED: 'false',
  });

  // Imported after the environment is in place: config namespaces read process.env when the module graph is built.
  const { AppModule } = await import('../../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz', 'metrics'] });
  await app.init();

  const dataSource = app.get(DataSource);

  await seedUsers(dataSource);
  await seedRates(dataSource);

  return {
    app,
    dataSource,
    close: async () => {
      await app.close();
      await container.stop();
    },
    reset: async () => {
      await dataSource.query(
        'TRUNCATE capacity_ledger_entries, invoice_reservations, outbox_messages, processed_messages, programs RESTART IDENTITY CASCADE',
      );
    },
    createProgram: (code, limit, currency) => {
      const money = Money.fromDecimal(limit, currency);

      return dataSource.getRepository(ProgramEntity).save({
        code,
        name: `Test program ${code}`,
        currency: money.currency,
        totalLimitMinor: money.minorUnits,
        reservedMinor: 0n,
      });
    },
    tokenFor: async (role) => {
      const { AuthService } = await import('../../src/auth/auth.service');
      const token = await app.get(AuthService).issueToken({
        email: emailFor(role),
        password: PASSWORD,
      });

      return token.accessToken;
    },
  };
}

function emailFor(role: UserRole): string {
  return `${role}@test.local`;
}

async function seedUsers(dataSource: DataSource): Promise<void> {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);

  for (const role of [UserRole.Admin, UserRole.Client, UserRole.Viewer]) {
    await dataSource.getRepository(UserEntity).save({
      email: emailFor(role),
      name: `Test ${role}`,
      roles: [role],
      passwordHash,
    });
  }
}

async function seedRates(dataSource: DataSource): Promise<void> {
  const asOf = new Date('2026-01-01T00:00:00.000Z');

  await dataSource.getRepository(FxRateEntity).save([
    { baseCurrency: 'EUR', quoteCurrency: 'USD', rate: '1.085000000000', asOf, source: 'TEST' },
    { baseCurrency: 'GBP', quoteCurrency: 'USD', rate: '1.270000000000', asOf, source: 'TEST' },
  ]);
}
