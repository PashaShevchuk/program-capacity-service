import { config as loadDotEnv } from 'dotenv';
import { DataSource, type DataSourceOptions } from 'typeorm';

import { UserEntity } from '../auth/user.entity';
import { FxRateEntity } from '../fx/fx-rate.entity';
import { ProcessedMessageEntity } from '../kafka/processed-message.entity';
import { CapacityLedgerEntryEntity } from '../ledger/capacity-ledger-entry.entity';
import { OutboxMessageEntity } from '../outbox/outbox-message.entity';
import { ProgramEntity } from '../programs/program.entity';
import { InvoiceReservationEntity } from '../reservations/invoice-reservation.entity';

loadDotEnv();

/** All entities in one place so the app and the migration CLI cannot diverge. */
export const ENTITIES = [
  UserEntity,
  ProgramEntity,
  InvoiceReservationEntity,
  CapacityLedgerEntryEntity,
  FxRateEntity,
  ProcessedMessageEntity,
  OutboxMessageEntity,
];

export function buildDataSourceOptions(overrides: Partial<DataSourceOptions> = {}): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'capacity',
    password: process.env.DB_PASSWORD ?? 'capacity',
    database: process.env.DB_NAME ?? 'capacity',
    entities: ENTITIES,
    migrations: [`${__dirname}/migrations/*.{ts,js}`],
    migrationsTableName: 'typeorm_migrations',
    // Schema changes go through reviewed migrations only. `synchronize` would
    // rewrite a production schema on deploy.
    synchronize: false,
    logging: process.env.DB_LOGGING === 'true' ? 'all' : ['error', 'warn', 'migration'],
    ...overrides,
  } as DataSourceOptions;
}

/** Used by the TypeORM CLI (`npm run migration:run`). */
export default new DataSource(buildDataSourceOptions());
