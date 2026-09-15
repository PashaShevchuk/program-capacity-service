import { randomUUID } from 'node:crypto';

import { MalformedMessageError } from '../../src/common/errors/domain.errors';
import { Money } from '../../src/common/money';
import { KafkaConsumerService } from '../../src/kafka/kafka-consumer.service';
import { type ParsedKafkaMessage } from '../../src/kafka/kafka-message';
import {
  CapacityLedgerEntryEntity,
  LedgerEntrySource,
  LedgerEntryType,
} from '../../src/ledger/capacity-ledger-entry.entity';
import { OutboxMessageEntity } from '../../src/outbox/outbox-message.entity';
import { CAPACITY_CHANGED_EVENT_TYPE } from '../../src/programs/capacity-changed.event';
import { ProgramEntity } from '../../src/programs/program.entity';
import {
  InvoiceReservationEntity,
  ReservationSource,
  ReservationStatus,
} from '../../src/reservations/invoice-reservation.entity';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { createTestContext, TEST_ACTOR, type TestContext } from '../helpers/test-app';

const EVENTS_TOPIC = 'treasury.capacity.events.v1';
const RECONCILIATION_TOPIC = 'treasury.capacity.reconciliation.v1';

describe('treasury messages', () => {
  let context: TestContext;
  let consumer: KafkaConsumerService;
  let reservations: ReservationsService;

  const message = (topic: string, body: Record<string, unknown>): ParsedKafkaMessage => ({
    topic,
    partition: 0,
    offset: '0',
    key: 'PRG-T',
    headers: {},
    body,
    eventId: body.eventId as string,
    eventType: (body.eventType as string) ?? null,
    timestamp: new Date(),
  });

  const program = () =>
    context.dataSource.getRepository(ProgramEntity).findOneByOrFail({ code: 'PRG-T' });

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
    await context.createProgram('PRG-T', '1000000.00', 'USD');
  });

  describe('reconciliation snapshots', () => {
    const snapshot = (overrides: Record<string, unknown> = {}) => ({
      eventId: randomUUID(),
      programCode: 'PRG-T',
      sequence: 100,
      occurredAt: new Date().toISOString(),
      asOf: new Date().toISOString(),
      totalLimit: { amount: '1200000.00', currency: 'USD' },
      reservedTotal: { amount: '300000.00', currency: 'USD' },
      ...overrides,
    });

    it('brings the program in line with the snapshot', async () => {
      await consumer.processMessage(message(RECONCILIATION_TOPIC, snapshot()));

      const updated = await program();

      expect(updated.totalLimit.toDecimalString()).toBe('1200000.00');
      expect(updated.reserved.toDecimalString()).toBe('300000.00');
      expect(updated.lastTreasurySequence).toBe(100n);
      expect(updated.lastReconciledAt).not.toBeNull();
    });

    it('explains the correction in the ledger', async () => {
      await consumer.processMessage(message(RECONCILIATION_TOPIC, snapshot()));

      const entries = await context.dataSource.getRepository(CapacityLedgerEntryEntity).find();

      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe(LedgerEntryType.ReconciliationAdjustment);
      expect(entries[0].source).toBe(LedgerEntrySource.TreasuryReconciliation);
      expect(entries[0].reservedDelta.toDecimalString()).toBe('300000.00');
      expect(entries[0].reservedAfter.toDecimalString()).toBe('300000.00');
    });

    it('applies a redelivered message only once', async () => {
      const body = snapshot();

      const first = await consumer.processMessage(message(RECONCILIATION_TOPIC, body));
      const second = await consumer.processMessage(message(RECONCILIATION_TOPIC, body));

      expect(first).toBe(true);
      expect(second).toBe(false);

      const updated = await program();
      expect(updated.reserved.toDecimalString()).toBe('300000.00');
      expect(await context.dataSource.getRepository(CapacityLedgerEntryEntity).count()).toBe(1);
    });

    it('ignores a snapshot that is older than one already applied', async () => {
      await consumer.processMessage(message(RECONCILIATION_TOPIC, snapshot({ sequence: 100 })));

      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            sequence: 99,
            totalLimit: { amount: '1.00', currency: 'USD' },
            reservedTotal: { amount: '0.00', currency: 'USD' },
          }),
        ),
      );

      const updated = await program();

      expect(updated.totalLimit.toDecimalString()).toBe('1200000.00');
      expect(updated.reserved.toDecimalString()).toBe('300000.00');
      expect(updated.lastTreasurySequence).toBe(100n);
    });

    it('keeps a reservation this service accepted after the snapshot was taken', async () => {
      const asOf = new Date(Date.now() - 60_000);

      // Treasury built its snapshot a minute ago; this arrived afterwards.
      await reservations.reserve({
        programRef: 'PRG-T',
        invoiceId: 'INV-LATE',
        amount: Money.fromDecimal('50000.00', 'USD'),
        source: ReservationSource.Api,
        ledgerSource: LedgerEntrySource.Api,
        actor: TEST_ACTOR,
      });

      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            asOf: asOf.toISOString(),
            reservedTotal: { amount: '300000.00', currency: 'USD' },
          }),
        ),
      );

      const updated = await program();

      // 300,000 from treasury plus the 50,000 it has not seen yet.
      expect(updated.reserved.toDecimalString()).toBe('350000.00');
    });

    it('does not resurrect a reservation released after the snapshot was taken', async () => {
      const reservedAt = new Date(Date.now() - 120_000);
      const asOf = new Date(Date.now() - 60_000);

      await reservations.reserve({
        programRef: 'PRG-T',
        invoiceId: 'INV-EARLY',
        amount: Money.fromDecimal('80000.00', 'USD'),
        source: ReservationSource.Api,
        ledgerSource: LedgerEntrySource.Api,
        actor: TEST_ACTOR,
        occurredAt: reservedAt,
      });

      await reservations.release({
        programRef: 'PRG-T',
        reservationRef: 'INV-EARLY',
        ledgerSource: LedgerEntrySource.Api,
        actor: TEST_ACTOR,
      });

      // The snapshot still counts that 80,000 as open.
      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            asOf: asOf.toISOString(),
            reservedTotal: { amount: '80000.00', currency: 'USD' },
          }),
        ),
      );

      const updated = await program();

      expect(updated.reserved.toDecimalString()).toBe('0.00');
    });

    it('leaves the ledger alone when local state already matches', async () => {
      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            totalLimit: { amount: '1000000.00', currency: 'USD' },
            reservedTotal: { amount: '0.00', currency: 'USD' },
          }),
        ),
      );

      expect(await context.dataSource.getRepository(CapacityLedgerEntryEntity).count()).toBe(0);

      const updated = await program();
      expect(updated.lastTreasurySequence).toBe(100n);
    });

    it('attributes the adjustment to the treasury system, not a user', async () => {
      await consumer.processMessage(message(RECONCILIATION_TOPIC, snapshot()));

      const [entry] = await context.dataSource.getRepository(CapacityLedgerEntryEntity).find();

      expect(entry.actor).toEqual({ type: 'TREASURY', id: null, label: 'treasury' });
    });

    it('recreates a reservation the snapshot lists but we never saw', async () => {
      // The reserve event for INV-LOST was lost, so only the snapshot knows it.
      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            reservedTotal: { amount: '300000.00', currency: 'USD' },
            openReservations: [
              { invoiceId: 'INV-LOST', amount: { amount: '300000.00', currency: 'USD' } },
            ],
          }),
        ),
      );

      const recreated = await context.dataSource
        .getRepository(InvoiceReservationEntity)
        .findOneByOrFail({ invoiceId: 'INV-LOST' });

      expect(recreated.status).toBe(ReservationStatus.Reserved);
      expect(recreated.source).toBe(ReservationSource.Treasury);
      expect(recreated.reservedAmount.toDecimalString()).toBe('300000.00');
      expect((await program()).reserved.toDecimalString()).toBe('300000.00');
    });

    it('lets a later release find a reservation the snapshot restored', async () => {
      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            reservedTotal: { amount: '300000.00', currency: 'USD' },
            openReservations: [
              { invoiceId: 'INV-LOST', amount: { amount: '300000.00', currency: 'USD' } },
            ],
          }),
        ),
      );

      // Before the row was restored this failed with RESERVATION_NOT_FOUND and
      // the capacity could never be returned.
      await consumer.processMessage(
        message(EVENTS_TOPIC, {
          eventId: randomUUID(),
          eventType: 'CapacityReleased',
          programCode: 'PRG-T',
          sequence: 200,
          occurredAt: new Date().toISOString(),
          payload: { invoiceId: 'INV-LOST' },
        }),
      );

      const released = await context.dataSource
        .getRepository(InvoiceReservationEntity)
        .findOneByOrFail({ invoiceId: 'INV-LOST' });

      expect(released.status).toBe(ReservationStatus.Released);
      expect((await program()).reserved.toDecimalString()).toBe('0.00');
    });

    it('closes a treasury reservation the snapshot no longer lists', async () => {
      const earlier = new Date(Date.now() - 120_000);

      await consumer.processMessage(
        message(EVENTS_TOPIC, {
          eventId: randomUUID(),
          eventType: 'CapacityReserved',
          programCode: 'PRG-T',
          sequence: 5,
          occurredAt: earlier.toISOString(),
          payload: { invoiceId: 'INV-GONE', amount: { amount: '90000.00', currency: 'USD' } },
        }),
      );

      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            reservedTotal: { amount: '0.00', currency: 'USD' },
            openReservations: [],
          }),
        ),
      );

      const gone = await context.dataSource
        .getRepository(InvoiceReservationEntity)
        .findOneByOrFail({ invoiceId: 'INV-GONE' });

      expect(gone.status).toBe(ReservationStatus.Cancelled);
      expect((await program()).reserved.toDecimalString()).toBe('0.00');
    });

    it('does not double-count a treasury reservation released through the API', async () => {
      const reservedAt = new Date(Date.now() - 120_000);
      const asOf = new Date(Date.now() - 60_000);

      await consumer.processMessage(
        message(EVENTS_TOPIC, {
          eventId: randomUUID(),
          eventType: 'CapacityReserved',
          programCode: 'PRG-T',
          sequence: 5,
          occurredAt: reservedAt.toISOString(),
          payload: { invoiceId: 'INV-MIXED', amount: { amount: '70000.00', currency: 'USD' } },
        }),
      );

      // Closed here, after the snapshot was taken, so the snapshot still counts it.
      await reservations.release({
        programRef: 'PRG-T',
        reservationRef: 'INV-MIXED',
        ledgerSource: LedgerEntrySource.Api,
        actor: TEST_ACTOR,
      });

      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            asOf: asOf.toISOString(),
            reservedTotal: { amount: '70000.00', currency: 'USD' },
          }),
        ),
      );

      // Classifying by who created the reservation rather than when it closed
      // would put the 70,000 back.
      expect((await program()).reserved.toDecimalString()).toBe('0.00');
    });

    it('ignores a snapshot describing an earlier moment than one applied', async () => {
      const newer = new Date(Date.now() - 60_000);
      const older = new Date(Date.now() - 600_000);

      await consumer.processMessage(
        message(RECONCILIATION_TOPIC, snapshot({ sequence: 100, asOf: newer.toISOString() })),
      );

      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            sequence: 101,
            asOf: older.toISOString(),
            reservedTotal: { amount: '0.00', currency: 'USD' },
          }),
        ),
      );

      expect((await program()).reserved.toDecimalString()).toBe('300000.00');
    });

    it('rejects open reservations quoted in another currency', async () => {
      await expect(
        consumer.processMessage(
          message(
            RECONCILIATION_TOPIC,
            snapshot({
              openReservations: [
                { invoiceId: 'INV-EUR', amount: { amount: '1000.00', currency: 'EUR' } },
              ],
            }),
          ),
        ),
      ).rejects.toThrow(MalformedMessageError);
    });

    it('restates an open reservation whose amount treasury disagrees with', async () => {
      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            reservedTotal: { amount: '100000.00', currency: 'USD' },
            openReservations: [
              { invoiceId: 'INV-AMT', amount: { amount: '100000.00', currency: 'USD' } },
            ],
          }),
        ),
      );

      await consumer.processMessage(
        message(
          RECONCILIATION_TOPIC,
          snapshot({
            sequence: 101,
            reservedTotal: { amount: '80000.00', currency: 'USD' },
            openReservations: [
              { invoiceId: 'INV-AMT', amount: { amount: '80000.00', currency: 'USD' } },
            ],
          }),
        ),
      );

      const row = await context.dataSource
        .getRepository(InvoiceReservationEntity)
        .findOneByOrFail({ invoiceId: 'INV-AMT' });

      // Leaving the row at 100,000 while the balance said 80,000 made a later
      // release drive the reserved total negative and fail.
      expect(row.reservedAmount.toDecimalString()).toBe('80000.00');
      expect((await program()).reserved.toDecimalString()).toBe('80000.00');
    });

    it('rejects a snapshot dated in the future', async () => {
      await expect(
        consumer.processMessage(
          message(
            RECONCILIATION_TOPIC,
            snapshot({ asOf: new Date(Date.now() + 86_400_000).toISOString() }),
          ),
        ),
      ).rejects.toThrow(MalformedMessageError);

      // A future watermark would have made every later snapshot look stale.
      expect((await program()).lastReconciledAt).toBeNull();
    });

    it('rejects a snapshot in the wrong currency', async () => {
      await expect(
        consumer.processMessage(
          message(
            RECONCILIATION_TOPIC,
            snapshot({ reservedTotal: { amount: '300000.00', currency: 'EUR' } }),
          ),
        ),
      ).rejects.toThrow();

      const updated = await program();
      expect(updated.totalLimit.toDecimalString()).toBe('1000000.00');
    });
  });

  describe('incremental events', () => {
    const event = (eventType: string, payload: Record<string, unknown>, sequence = 10) => ({
      eventId: randomUUID(),
      eventType,
      programCode: 'PRG-T',
      sequence,
      occurredAt: new Date().toISOString(),
      payload,
    });

    it('mirrors a reservation made in the treasury system', async () => {
      await consumer.processMessage(
        message(
          EVENTS_TOPIC,
          event('CapacityReserved', {
            invoiceId: 'INV-TR',
            amount: { amount: '100000.00', currency: 'EUR' },
            externalReference: 'TR-1',
          }),
        ),
      );

      const reservation = await context.dataSource
        .getRepository(InvoiceReservationEntity)
        .findOneByOrFail({ invoiceId: 'INV-TR' });

      expect(reservation.source).toBe(ReservationSource.Treasury);
      expect(reservation.externalReference).toBe('TR-1');
      expect(reservation.reservedAmount.toDecimalString()).toBe('108500.00');

      const updated = await program();
      expect(updated.reserved.toDecimalString()).toBe('108500.00');
    });

    it('releases a reservation when treasury reports repayment', async () => {
      await consumer.processMessage(
        message(
          EVENTS_TOPIC,
          event('CapacityReserved', {
            invoiceId: 'INV-TR2',
            amount: { amount: '100000.00', currency: 'USD' },
          }),
        ),
      );

      await consumer.processMessage(
        message(EVENTS_TOPIC, event('CapacityReleased', { invoiceId: 'INV-TR2' }, 11)),
      );

      const reservation = await context.dataSource
        .getRepository(InvoiceReservationEntity)
        .findOneByOrFail({ invoiceId: 'INV-TR2' });

      expect(reservation.status).toBe(ReservationStatus.Released);
      expect((await program()).reserved.toDecimalString()).toBe('0.00');
    });

    it('applies a limit change', async () => {
      await consumer.processMessage(
        message(
          EVENTS_TOPIC,
          event('ProgramLimitChanged', { totalLimit: { amount: '3000000.00', currency: 'USD' } }),
        ),
      );

      expect((await program()).totalLimit.toDecimalString()).toBe('3000000.00');
    });

    it('accepts a treasury reserve that takes the program over its limit', async () => {
      // Treasury reports what already happened at the source of truth.
      // Refusing it would leave the two permanently out of step.
      await consumer.processMessage(
        message(
          EVENTS_TOPIC,
          event('CapacityReserved', {
            invoiceId: 'INV-OVER',
            amount: { amount: '5000000.00', currency: 'USD' },
          }),
        ),
      );

      const over = await program();

      expect(over.reserved.toDecimalString()).toBe('5000000.00');
      expect(over.isOvercommitted).toBe(true);
    });

    it('accepts a release for a reservation reconciliation already closed', async () => {
      const earlier = new Date(Date.now() - 120_000);

      await consumer.processMessage(
        message(
          EVENTS_TOPIC,
          event(
            'CapacityReserved',
            { invoiceId: 'INV-CLOSED', amount: { amount: '1000.00', currency: 'USD' } },
            3,
          ),
        ),
      );
      await context.dataSource
        .getRepository(InvoiceReservationEntity)
        .update({ invoiceId: 'INV-CLOSED' }, { reservedAt: earlier });

      // A snapshot drops it, so reconciliation cancels the row.
      await consumer.processMessage(
        message(RECONCILIATION_TOPIC, {
          eventId: randomUUID(),
          programCode: 'PRG-T',
          sequence: 50,
          occurredAt: new Date().toISOString(),
          asOf: new Date().toISOString(),
          totalLimit: { amount: '1000000.00', currency: 'USD' },
          reservedTotal: { amount: '0.00', currency: 'USD' },
          openReservations: [],
        }),
      );

      // Treasury then reports the release it had already applied. Before, this
      // was an invalid transition and went to the DLQ.
      await expect(
        consumer.processMessage(
          message(EVENTS_TOPIC, event('CapacityReleased', { invoiceId: 'INV-CLOSED' }, 51)),
        ),
      ).resolves.toBe(true);
    });

    it('treats a malformed payload as permanently broken', async () => {
      await expect(
        consumer.processMessage(
          message(EVENTS_TOPIC, event('CapacityReserved', { invoiceId: '', amount: {} })),
        ),
      ).rejects.toThrow(MalformedMessageError);

      expect((await program()).reserved.toDecimalString()).toBe('0.00');
    });

    it('publishes a limit change so subscribers are not left stale', async () => {
      await consumer.processMessage(
        message(
          EVENTS_TOPIC,
          event('ProgramLimitChanged', { totalLimit: { amount: '3000000.00', currency: 'USD' } }),
        ),
      );

      const published = await context.dataSource
        .getRepository(OutboxMessageEntity)
        .find({ where: { eventType: CAPACITY_CHANGED_EVENT_TYPE } });

      expect(published).toHaveLength(1);
      expect(published[0].payload).toMatchObject({
        reason: 'LIMIT_CHANGE',
        totalLimit: '3000000.00',
      });
    });

    it('ignores an event whose sequence has already been passed', async () => {
      await consumer.processMessage(
        message(
          EVENTS_TOPIC,
          event(
            'ProgramLimitChanged',
            { totalLimit: { amount: '3000000.00', currency: 'USD' } },
            20,
          ),
        ),
      );

      await consumer.processMessage(
        message(
          EVENTS_TOPIC,
          event('ProgramLimitChanged', { totalLimit: { amount: '9.00', currency: 'USD' } }, 19),
        ),
      );

      expect((await program()).totalLimit.toDecimalString()).toBe('3000000.00');
    });
  });
});
