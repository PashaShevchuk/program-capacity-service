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
import { ProgramEntity } from '../../src/programs/program.entity';
import {
  InvoiceReservationEntity,
  ReservationSource,
  ReservationStatus,
} from '../../src/reservations/invoice-reservation.entity';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { createTestContext, type TestContext } from '../helpers/test-app';

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
        occurredAt: reservedAt,
      });

      await reservations.release({
        programRef: 'PRG-T',
        reservationRef: 'INV-EARLY',
        ledgerSource: LedgerEntrySource.Api,
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

    it('treats a malformed payload as permanently broken', async () => {
      await expect(
        consumer.processMessage(
          message(EVENTS_TOPIC, event('CapacityReserved', { invoiceId: '', amount: {} })),
        ),
      ).rejects.toThrow(MalformedMessageError);

      expect((await program()).reserved.toDecimalString()).toBe('0.00');
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
