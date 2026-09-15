import { InsufficientCapacityError } from '../../src/common/errors/domain.errors';
import { Money } from '../../src/common/money';
import { LedgerEntrySource, LedgerEntryType } from '../../src/ledger/capacity-ledger-entry.entity';
import { CapacityLedgerEntryEntity } from '../../src/ledger/capacity-ledger-entry.entity';
import { ProgramEntity } from '../../src/programs/program.entity';
import { ReservationSource } from '../../src/reservations/invoice-reservation.entity';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { createTestContext, TEST_ACTOR, type TestContext } from '../helpers/test-app';

describe('concurrent reservations', () => {
  let context: TestContext;
  let reservations: ReservationsService;

  beforeAll(async () => {
    context = await createTestContext();
    reservations = context.app.get(ReservationsService);
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('never reserves more than the limit when requests race', async () => {
    // 33 of these fit into the limit; the 34th would take it to 1,020,000.
    await context.createProgram('PRG-RACE', '1000000.00', 'USD');

    const attempts = 50;
    const each = Money.fromDecimal('30000.00', 'USD');

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, index) =>
        reservations.reserve({
          programRef: 'PRG-RACE',
          invoiceId: `INV-${index}`,
          amount: each,
          source: ReservationSource.Api,
          ledgerSource: LedgerEntrySource.Api,
          actor: TEST_ACTOR,
        }),
      ),
    );

    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(accepted).toHaveLength(33);
    expect(rejected).toHaveLength(17);
    expect(rejected.every((result) => result.reason instanceof InsufficientCapacityError)).toBe(
      true,
    );

    const program = await context.dataSource
      .getRepository(ProgramEntity)
      .findOneByOrFail({ code: 'PRG-RACE' });

    expect(program.reserved.toDecimalString()).toBe('990000.00');
    expect(program.available.toDecimalString()).toBe('10000.00');
    expect(program.reservedMinor).toBeLessThanOrEqual(program.totalLimitMinor);
  });

  it('records exactly one ledger entry per accepted reservation', async () => {
    await context.createProgram('PRG-LEDGER', '100000.00', 'USD');

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        reservations.reserve({
          programRef: 'PRG-LEDGER',
          invoiceId: `INV-${index}`,
          amount: Money.fromDecimal('10000.00', 'USD'),
          source: ReservationSource.Api,
          ledgerSource: LedgerEntrySource.Api,
          actor: TEST_ACTOR,
        }),
      ),
    );

    const accepted = results.filter((result) => result.status === 'fulfilled').length;

    const entries = await context.dataSource.getRepository(CapacityLedgerEntryEntity).find({
      where: { entryType: LedgerEntryType.Reserve },
      order: { reservedAfterMinor: 'ASC' },
    });

    expect(accepted).toBe(10);
    expect(entries).toHaveLength(10);

    // Ordered by balance rather than by time, because concurrent writes share a
    // timestamp. Each step must appear exactly once: no gaps, no repeats, which
    // is what a lost update would produce.
    expect(entries.map((entry) => entry.reservedAfter.toDecimalString())).toEqual([
      '10000.00',
      '20000.00',
      '30000.00',
      '40000.00',
      '50000.00',
      '60000.00',
      '70000.00',
      '80000.00',
      '90000.00',
      '100000.00',
    ]);
  });

  it('keeps the balance correct when reserves and releases interleave', async () => {
    await context.createProgram('PRG-MIX', '500000.00', 'USD');

    const open = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        reservations.reserve({
          programRef: 'PRG-MIX',
          invoiceId: `INV-${index}`,
          amount: Money.fromDecimal('20000.00', 'USD'),
          source: ReservationSource.Api,
          ledgerSource: LedgerEntrySource.Api,
          actor: TEST_ACTOR,
        }),
      ),
    );

    expect(open).toHaveLength(10);

    // Release five while five more reservations come in at the same time.
    await Promise.all([
      ...Array.from({ length: 5 }, (_, index) =>
        reservations.release({
          programRef: 'PRG-MIX',
          reservationRef: `INV-${index}`,
          ledgerSource: LedgerEntrySource.Api,
          actor: TEST_ACTOR,
        }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        reservations.reserve({
          programRef: 'PRG-MIX',
          invoiceId: `INV-NEW-${index}`,
          amount: Money.fromDecimal('20000.00', 'USD'),
          source: ReservationSource.Api,
          ledgerSource: LedgerEntrySource.Api,
          actor: TEST_ACTOR,
        }),
      ),
    ]);

    const program = await context.dataSource
      .getRepository(ProgramEntity)
      .findOneByOrFail({ code: 'PRG-MIX' });

    // 10 opened, 5 closed, 5 opened again = 10 open at 20,000 each.
    expect(program.reserved.toDecimalString()).toBe('200000.00');
  });
});
