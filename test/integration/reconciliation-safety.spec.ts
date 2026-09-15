import { randomUUID } from 'node:crypto';

import {
  InsufficientCapacityError,
  MalformedMessageError,
} from '../../src/common/errors/domain.errors';
import { Money } from '../../src/common/money/money';
import { KafkaConsumerService } from '../../src/kafka/kafka-consumer.service';
import { type ParsedKafkaMessage } from '../../src/kafka/kafka-message';
import { LedgerEntrySource } from '../../src/ledger/capacity-ledger-entry.entity';
import { ProgramEntity } from '../../src/programs/program.entity';
import {
  InvoiceReservationEntity,
  ReservationSource,
  ReservationStatus,
} from '../../src/reservations/invoice-reservation.entity';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { createTestContext, TEST_ACTOR, type TestContext } from '../helpers/test-app';

const RECONCILIATION_TOPIC = 'treasury.capacity.reconciliation.v1';

/**
 * A snapshot describes a moment on treasury's clock. It cannot say whether
 * treasury has *received* a reservation this service accepted just before that
 * moment, so trusting the timestamp alone can drop a reservation out of the
 * balance while its row stays open — and the capacity gets handed out twice.
 */
describe('reconciliation safety', () => {
  let context: TestContext;
  let consumer: KafkaConsumerService;
  let reservations: ReservationsService;

  const snapshot = (overrides: Record<string, unknown> = {}): ParsedKafkaMessage => {
    const body = {
      eventId: randomUUID(),
      programCode: 'PRG-SAFE',
      sequence: 1,
      occurredAt: new Date().toISOString(),
      asOf: new Date().toISOString(),
      totalLimit: { amount: '1000.00', currency: 'USD' },
      reservedTotal: { amount: '0.00', currency: 'USD' },
      ...overrides,
    };

    return {
      topic: RECONCILIATION_TOPIC,
      partition: 0,
      offset: '0',
      key: 'PRG-SAFE',
      headers: {},
      body,
      eventId: body.eventId,
      eventType: null,
      timestamp: new Date(),
    };
  };

  const program = () =>
    context.dataSource.getRepository(ProgramEntity).findOneByOrFail({ code: 'PRG-SAFE' });

  const openTotal = async (): Promise<bigint> => {
    const rows = await context.dataSource
      .getRepository(InvoiceReservationEntity)
      .findBy({ status: ReservationStatus.Reserved });

    return rows.reduce((total, row) => total + row.reservedAmountMinor, 0n);
  };

  beforeAll(async () => {
    context = await createTestContext();
    consumer = context.app.get(KafkaConsumerService);
    reservations = context.app.get(ReservationsService);
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    await context.createProgram('PRG-SAFE', '1000.00', 'USD');
  });

  const reserve = (invoiceId: string, amount: string) =>
    reservations.reserve({
      programRef: 'PRG-SAFE',
      invoiceId,
      amount: Money.fromDecimal(amount, 'USD'),
      source: ReservationSource.Api,
      ledgerSource: LedgerEntrySource.Api,
      actor: TEST_ACTOR,
    });

  it('keeps a reservation treasury has not seen yet', async () => {
    await reserve('INV-PENDING', '900.00');

    await consumer.processMessage(snapshot({ openReservations: [] }));

    expect((await program()).reserved.toDecimalString()).toBe('900.00');
  });

  it('does not let the freed capacity be reserved a second time', async () => {
    await reserve('INV-PENDING', '900.00');

    await consumer.processMessage(snapshot({ openReservations: [] }));

    // Without the floor this succeeded and the program held 1,800 against a
    // 1,000 limit.
    await expect(reserve('INV-SECOND', '900.00')).rejects.toThrow(InsufficientCapacityError);

    const after = await program();
    expect(after.reservedMinor).toBeGreaterThanOrEqual(await openTotal());
    expect(after.reservedMinor).toBeLessThanOrEqual(after.totalLimitMinor);
  });

  it('holds the balance at the open rows, never below them', async () => {
    await reserve('INV-A', '400.00');
    await reserve('INV-B', '300.00');

    // Aggregate-only snapshot: no detail, so the rows are the only evidence of
    // what is outstanding.
    await consumer.processMessage(
      snapshot({ reservedTotal: { amount: '100.00', currency: 'USD' } }),
    );

    expect((await program()).reservedMinor).toBe(await openTotal());
    expect((await program()).reserved.toDecimalString()).toBe('700.00');
  });

  it('still lets treasury raise the reserved total above what we hold', async () => {
    await reserve('INV-A', '100.00');

    await consumer.processMessage(
      snapshot({ reservedTotal: { amount: '500.00', currency: 'USD' } }),
    );

    expect((await program()).reserved.toDecimalString()).toBe('500.00');
  });

  describe('when the snapshot carries detail', () => {
    it('does not hold capacity for an invoice that is already released here', async () => {
      const reservedAt = new Date(Date.now() - 120_000);
      const asOf = new Date(Date.now() - 60_000);

      await reservations.reserve({
        programRef: 'PRG-SAFE',
        invoiceId: 'INV-DONE',
        amount: Money.fromDecimal('80.00', 'USD'),
        source: ReservationSource.Api,
        ledgerSource: LedgerEntrySource.Api,
        actor: TEST_ACTOR,
        occurredAt: reservedAt,
      });
      await reservations.release({
        programRef: 'PRG-SAFE',
        reservationRef: 'INV-DONE',
        ledgerSource: LedgerEntrySource.Api,
        actor: TEST_ACTOR,
        occurredAt: new Date(Date.now() - 90_000),
      });

      // Treasury has not caught up and still lists it.
      await consumer.processMessage(
        snapshot({
          asOf: asOf.toISOString(),
          reservedTotal: { amount: '80.00', currency: 'USD' },
          openReservations: [
            { invoiceId: 'INV-DONE', amount: { amount: '80.00', currency: 'USD' } },
          ],
        }),
      );

      // The row stays closed, so holding 80 against it would block capacity
      // that nothing can ever release.
      expect(await openTotal()).toBe(0n);
      expect((await program()).reserved.toDecimalString()).toBe('0.00');
    });

    it('counts an invoice the snapshot lists exactly once', async () => {
      const asOf = new Date(Date.now() - 60_000);

      // Opened after asOf, yet treasury already knows about it.
      await reserve('INV-BOTH', '100.00');

      await consumer.processMessage(
        snapshot({
          asOf: asOf.toISOString(),
          reservedTotal: { amount: '100.00', currency: 'USD' },
          openReservations: [
            { invoiceId: 'INV-BOTH', amount: { amount: '100.00', currency: 'USD' } },
          ],
        }),
      );

      expect((await program()).reserved.toDecimalString()).toBe('100.00');
      expect((await program()).reservedMinor).toBe(await openTotal());
    });

    it('restates the held amount without rewriting the invoice or its rate', async () => {
      await reservations.reserve({
        programRef: 'PRG-SAFE',
        invoiceId: 'INV-EUR',
        amount: Money.fromDecimal('100.00', 'EUR'),
        source: ReservationSource.Api,
        ledgerSource: LedgerEntrySource.Api,
        actor: TEST_ACTOR,
      });

      await consumer.processMessage(
        snapshot({
          reservedTotal: { amount: '80.00', currency: 'USD' },
          openReservations: [
            { invoiceId: 'INV-EUR', amount: { amount: '80.00', currency: 'USD' } },
          ],
        }),
      );

      const row = await context.dataSource
        .getRepository(InvoiceReservationEntity)
        .findOneByOrFail({ invoiceId: 'INV-EUR' });

      // What treasury holds changed; what the invoice was and what rate applied
      // to it did not, and the audit depends on both staying put.
      expect(row.reservedAmount.toDecimalString()).toBe('80.00');
      expect(row.invoiceAmount.toDecimalString()).toBe('100.00');
      expect(row.invoiceCurrency).toBe('EUR');
      expect(row.fxRate).toBe('1.085000000000');
      expect(row.fxRateSource).toBe('TEST');
    });
  });

  it('parks a snapshot whose detail disagrees with its own total', async () => {
    await expect(
      consumer.processMessage(
        snapshot({
          reservedTotal: { amount: '500.00', currency: 'USD' },
          openReservations: [{ invoiceId: 'INV-X', amount: { amount: '300.00', currency: 'USD' } }],
        }),
      ),
    ).rejects.toThrow(MalformedMessageError);

    expect((await program()).reserved.toDecimalString()).toBe('0.00');
  });

  it('parks a snapshot that lists the same invoice twice', async () => {
    await expect(
      consumer.processMessage(
        snapshot({
          reservedTotal: { amount: '200.00', currency: 'USD' },
          openReservations: [
            { invoiceId: 'INV-X', amount: { amount: '100.00', currency: 'USD' } },
            { invoiceId: 'INV-X', amount: { amount: '100.00', currency: 'USD' } },
          ],
        }),
      ),
    ).rejects.toThrow(MalformedMessageError);
  });
});
