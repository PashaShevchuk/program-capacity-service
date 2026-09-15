import * as bcrypt from 'bcryptjs';
import { type DataSource } from 'typeorm';

import { UserEntity, UserRole } from '../../auth/user.entity';
import { Money } from '../../common/money';
import { FxRateEntity } from '../../fx/fx-rate.entity';
import { ProgramEntity } from '../../programs/program.entity';
import dataSource from '../data-source';

/**
 * Seeds the data a fresh local stack needs: users to log in with, two programs
 * in different currencies, and the FX rates those programs need.
 * Safe to run repeatedly.
 */
async function seed(source: DataSource): Promise<void> {
  await seedUsers(source);
  await seedPrograms(source);
  await seedFxRates(source);
}

async function seedUsers(source: DataSource): Promise<void> {
  const users = [
    {
      email: process.env.SEED_ADMIN_EMAIL ?? 'admin@demo.local',
      password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!',
      name: 'Demo Admin',
      roles: [UserRole.Admin],
    },
    {
      email: process.env.SEED_CLIENT_EMAIL ?? 'client@demo.local',
      password: process.env.SEED_CLIENT_PASSWORD ?? 'Client123!',
      name: 'Demo Client',
      roles: [UserRole.Client],
    },
    {
      email: 'viewer@demo.local',
      password: 'Viewer123!',
      name: 'Demo Viewer',
      roles: [UserRole.Viewer],
    },
  ];

  for (const user of users) {
    const existing = await source
      .getRepository(UserEntity)
      .createQueryBuilder('user')
      .where('lower(user.email) = lower(:email)', { email: user.email })
      .getOne();

    if (existing) continue;

    await source.getRepository(UserEntity).save({
      email: user.email,
      name: user.name,
      roles: user.roles,
      passwordHash: await bcrypt.hash(user.password, 10),
    });

    process.stdout.write(`user ${user.email} (${user.roles.join(', ')})\n`);
  }
}

async function seedPrograms(source: DataSource): Promise<void> {
  const programs = [
    {
      code: 'PRG-USD-001',
      name: 'Global Supplier Finance USD',
      totalLimit: Money.fromDecimal('10000000.00', 'USD'),
    },
    {
      code: 'PRG-EUR-001',
      name: 'European Receivables EUR',
      totalLimit: Money.fromDecimal('5000000.00', 'EUR'),
    },
  ];

  for (const program of programs) {
    const existing = await source.getRepository(ProgramEntity).findOneBy({ code: program.code });
    if (existing) continue;

    await source.getRepository(ProgramEntity).save({
      code: program.code,
      name: program.name,
      currency: program.totalLimit.currency,
      totalLimitMinor: program.totalLimit.minorUnits,
      reservedMinor: 0n,
    });

    process.stdout.write(`program ${program.code} with a ${program.totalLimit.toString()} limit\n`);
  }
}

async function seedFxRates(source: DataSource): Promise<void> {
  // One effective date keeps the seed deterministic; a real feed appends rows.
  const asOf = new Date('2026-01-01T00:00:00.000Z');

  const rates = [
    { base: 'EUR', quote: 'USD', rate: '1.085000000000' },
    { base: 'GBP', quote: 'USD', rate: '1.270000000000' },
    { base: 'CHF', quote: 'USD', rate: '1.120000000000' },
    { base: 'PLN', quote: 'USD', rate: '0.250000000000' },
    { base: 'UAH', quote: 'USD', rate: '0.024000000000' },
    { base: 'JPY', quote: 'USD', rate: '0.006700000000' },
    { base: 'USD', quote: 'EUR', rate: '0.921658986175' },
    { base: 'GBP', quote: 'EUR', rate: '1.170000000000' },
    { base: 'PLN', quote: 'EUR', rate: '0.230000000000' },
  ];

  for (const rate of rates) {
    const existing = await source.getRepository(FxRateEntity).findOneBy({
      baseCurrency: rate.base,
      quoteCurrency: rate.quote,
      asOf,
    });

    if (existing) continue;

    await source.getRepository(FxRateEntity).save({
      baseCurrency: rate.base,
      quoteCurrency: rate.quote,
      rate: rate.rate,
      asOf,
      source: 'SEED',
    });
  }

  process.stdout.write(`${rates.length} FX rates\n`);
}

async function main(): Promise<void> {
  const source = await dataSource.initialize();

  try {
    await seed(source);
    process.stdout.write('seed complete\n');
  } finally {
    await source.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${String(error)}\n`);
  process.exit(1);
});
