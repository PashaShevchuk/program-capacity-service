import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { EntityManager, In } from 'typeorm';

import { CurrencyMismatchError, MalformedMessageError } from '../../common/errors/domain.errors';
import { MoneyDto } from '../../common/money/money.dto';
import { Money } from '../../common/money';
import { kafkaConfig } from '../../config/configuration';
import { KafkaHandlerRegistry } from '../../kafka/kafka-handler.registry';
import {
  type AfterCommit,
  type KafkaMessageHandler,
  type ParsedKafkaMessage,
} from '../../kafka/kafka-message';
import { LedgerEntrySource, LedgerEntryType } from '../../ledger/capacity-ledger-entry.entity';
import { TREASURY_ACTOR } from '../../ledger/ledger-actor';
import { LedgerService } from '../../ledger/ledger.service';
import { MetricsService } from '../../metrics/metrics.service';
import { OutboxService } from '../../outbox/outbox.service';
import {
  CAPACITY_CHANGED_EVENT_TYPE,
  buildCapacityChangedPayload,
} from '../../programs/capacity-changed.event';
import { CapacityEventsService } from '../../programs/capacity-events.service';
import { ProgramCapacityRepository } from '../../programs/program-capacity.repository';
import { type ProgramEntity } from '../../programs/program.entity';
import {
  InvoiceReservationEntity,
  ReservationSource,
  ReservationStatus,
} from '../../reservations/invoice-reservation.entity';
import { OpenReservationDto, TreasuryReconciliationDto } from '../dto/treasury-messages.dto';
import { parseMessageBody } from '../message-validation';
import { isStaleSequence, isStaleSnapshot, reconcileCapacity } from '../reconciliation.calculator';

/** Clock skew tolerated on a snapshot's own timestamps. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Applies a full-state snapshot from the treasury system.
 *
 * Treasury is the source of truth as at the snapshot's `asOf`, but this service
 * may have moved on since. Local changes made after that moment are layered
 * back on top, and whatever difference remains is written to the ledger as an
 * adjustment rather than applied silently.
 */
@Injectable()
export class TreasuryReconciliationHandler implements KafkaMessageHandler, OnModuleInit {
  private readonly logger = new Logger(TreasuryReconciliationHandler.name);

  readonly topic: string;

  constructor(
    private readonly registry: KafkaHandlerRegistry,
    private readonly programs: ProgramCapacityRepository,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly capacityEvents: CapacityEventsService,
    private readonly metrics: MetricsService,
    @Inject(kafkaConfig.KEY) private readonly config: ConfigType<typeof kafkaConfig>,
  ) {
    this.topic = config.topics.treasuryReconciliation;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(message: ParsedKafkaMessage, manager: EntityManager): Promise<AfterCommit | void> {
    const snapshot = parseMessageBody(this.topic, TreasuryReconciliationDto, message.body);
    const program = await this.programs.lockProgram(manager, snapshot.programCode);
    const sequence = BigInt(snapshot.sequence);

    if (isStaleSequence(program.lastTreasurySequence, sequence)) {
      this.logger.warn(
        `Ignoring snapshot ${sequence} for ${snapshot.programCode}: ${program.lastTreasurySequence} has already been applied`,
      );
      return;
    }

    const asOf = new Date(snapshot.asOf);

    // A snapshot dated in the future would become the watermark and make every
    // later one look stale, so the program would stop reconciling entirely.
    if (asOf.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) {
      throw new MalformedMessageError(this.topic, [
        `asOf ${snapshot.asOf} is more than ${MAX_CLOCK_SKEW_MS}ms in the future`,
      ]);
    }

    if (isStaleSnapshot(program.lastReconciledAt, asOf)) {
      this.logger.warn(
        `Ignoring snapshot ${sequence} for ${snapshot.programCode}: it describes ${snapshot.asOf}, ` +
          `older than the ${program.lastReconciledAt?.toISOString()} already applied`,
      );
      return;
    }

    const snapshotLimit = MoneyDto.toMoney(snapshot.totalLimit);
    const snapshotReserved = MoneyDto.toMoney(snapshot.reservedTotal);

    if (
      snapshotLimit.currency !== program.currency ||
      snapshotReserved.currency !== program.currency
    ) {
      throw new CurrencyMismatchError(program.currency, snapshotLimit.currency);
    }

    this.assertSnapshotIsConsistent(snapshot, snapshotReserved);

    // Rebuild the reservation rows first, timestamped at `asOf` so they do not
    // register as movements the snapshot has not seen.
    await this.reconcileReservationRows(manager, program, snapshot, asOf, message.eventId);

    const local = await this.localMovementsSince(manager, program, asOf);
    const openReservationsMinor = await this.openReservationsTotal(manager, program);

    const outcome = reconcileCapacity({
      snapshotReservedMinor: snapshotReserved.minorUnits,
      snapshotLimitMinor: snapshotLimit.minorUnits,
      currentReservedMinor: program.reservedMinor,
      currentLimitMinor: program.totalLimitMinor,
      openedLocallyAfterSnapshotMinor: local.opened,
      closedLocallyAfterSnapshotMinor: local.closed,
      openReservationsMinor,
    });

    if (outcome.flooredToOpenRows) {
      this.logger.error(
        `Snapshot ${sequence} for ${program.code} reported less reserved than the ` +
          `${openReservationsMinor} minor units still open here; holding the higher figure. ` +
          `Treasury has most likely not received a recent reservation yet.`,
      );
    }

    if (!outcome.hasDrift && !outcome.hasLimitChange) {
      await this.programs.markTreasuryProgress(manager, program, sequence, asOf);
      this.logger.log(`Snapshot ${sequence} for ${program.code} matched local state`);
      return;
    }

    await this.programs.applyChange(manager, program, {
      reservedDelta: outcome.reservedAdjustmentMinor,
      limitDelta: outcome.limitAdjustmentMinor,
      treasurySequence: sequence,
      reconciledAt: asOf,
    });

    await this.ledger.append(manager, {
      program,
      entryType: LedgerEntryType.ReconciliationAdjustment,
      source: LedgerEntrySource.TreasuryReconciliation,
      actor: TREASURY_ACTOR,
      reservedDelta: outcome.reservedAdjustmentMinor,
      limitDelta: outcome.limitAdjustmentMinor,
      correlationId: message.eventId,
      occurredAt: asOf,
      reason: `Treasury snapshot ${sequence} as at ${snapshot.asOf}`,
      metadata: {
        snapshotReserved: snapshotReserved.toDecimalString(),
        snapshotLimit: snapshotLimit.toDecimalString(),
        openedLocallyAfterSnapshot: local.opened.toString(),
        closedLocallyAfterSnapshot: local.closed.toString(),
        expectedReserved: outcome.expectedReservedMinor.toString(),
      },
    });

    await this.outbox.enqueue(manager, {
      topic: this.config.topics.capacityChanged,
      messageKey: program.id,
      eventType: CAPACITY_CHANGED_EVENT_TYPE,
      payload: buildCapacityChangedPayload(program, 'RECONCILIATION'),
    });

    this.logger.warn(
      `Snapshot ${sequence} adjusted ${program.code} reserved by ${outcome.reservedAdjustmentMinor} minor units`,
    );

    const payload = buildCapacityChangedPayload(program, 'RECONCILIATION');

    return () => {
      this.metrics.recordCapacity(program);
      this.capacityEvents.publish(payload);
    };
  }

  /**
   * Brings the individual reservation rows in line with the snapshot.
   *
   * Correcting only the total would leave the program's balance right while the
   * reservations behind it were wrong: an invoice whose reserve event was lost
   * would stay invisible, and a later release for it would fail with
   * RESERVATION_NOT_FOUND. The snapshot lists what treasury holds open, so it
   * is used to recreate what is missing and close what is gone.
   *
   * These row changes carry no capacity delta of their own. The single
   * adjustment entry below moves the balance; the entries written here explain
   * the rows, so capacity has exactly one source of truth.
   */
  private async reconcileReservationRows(
    manager: EntityManager,
    program: ProgramEntity,
    snapshot: TreasuryReconciliationDto,
    asOf: Date,
    correlationId: string,
  ): Promise<void> {
    const listed = snapshot.openReservations;

    // An omitted list means the snapshot says nothing about individual rows.
    // An empty one means treasury holds nothing open, which is a statement.
    if (listed === undefined) return;

    const wrongCurrency = listed.filter((item) => item.amount.currency !== program.currency);
    if (wrongCurrency.length > 0) {
      // The contract says these are quoted in the program's own currency; the
      // snapshot carries no rate, so there is nothing to convert them with.
      throw new MalformedMessageError(this.topic, [
        `openReservations must be in ${program.currency}: ${wrongCurrency
          .map((item) => `${item.invoiceId} is ${item.amount.currency}`)
          .join(', ')}`,
      ]);
    }

    const listedByInvoice = new Map(listed.map((item) => [item.invoiceId, item]));

    const known = listedByInvoice.size
      ? await manager.find(InvoiceReservationEntity, {
          where: { programId: program.id, invoiceId: In([...listedByInvoice.keys()]) },
        })
      : [];
    const knownByInvoice = new Map(known.map((row) => [row.invoiceId, row]));

    for (const [invoiceId, item] of listedByInvoice) {
      const existing = knownByInvoice.get(invoiceId);

      if (!existing) {
        await this.recreateReservation(manager, program, item, asOf, correlationId, snapshot);
        continue;
      }

      if (!existing.isOpen) {
        // We have an explicit release for it and treasury has not caught up.
        // Local evidence is more specific, so the row stays closed.
        this.logger.warn(
          `Snapshot ${snapshot.sequence} still lists invoice ${invoiceId} as open, but it is ${existing.status} here`,
        );
        continue;
      }

      const listedAmount = Money.fromMoneyLike(item.amount);
      if (listedAmount.minorUnits !== existing.reservedAmountMinor) {
        // Leaving the row on a different figure than the balance was rebuilt
        // from would make a later release subtract more than is reserved, and
        // the database would reject it with the reservation stuck open.
        await this.correctReservationAmount(
          manager,
          program,
          existing,
          listedAmount,
          asOf,
          correlationId,
          snapshot,
        );
      }
    }

    await this.closeReservationsMissingFrom(
      manager,
      program,
      listedByInvoice,
      asOf,
      correlationId,
      snapshot,
    );
  }

  /** Moves an open row onto the figure treasury reports for it. */
  private async correctReservationAmount(
    manager: EntityManager,
    program: ProgramEntity,
    reservation: InvoiceReservationEntity,
    listedAmount: Money,
    asOf: Date,
    correlationId: string,
    snapshot: TreasuryReconciliationDto,
  ): Promise<void> {
    const previous = reservation.reservedAmount;

    reservation.invoiceAmountMinor = listedAmount.minorUnits;
    reservation.invoiceCurrency = program.currency;
    reservation.reservedAmountMinor = listedAmount.minorUnits;
    reservation.fxRate = '1';
    reservation.fxRateSource = 'RECONCILIATION';
    reservation.fxRateAt = asOf;
    await manager.save(InvoiceReservationEntity, reservation);

    await this.ledger.append(manager, {
      program,
      entryType: LedgerEntryType.ReconciliationAdjustment,
      source: LedgerEntrySource.TreasuryReconciliation,
      actor: TREASURY_ACTOR,
      reservedDelta: 0n,
      reservationId: reservation.id,
      correlationId,
      occurredAt: asOf,
      reason:
        `Snapshot ${snapshot.sequence} restated invoice ${reservation.invoiceId} from ` +
        `${previous.toDecimalString()} to ${listedAmount.toDecimalString()}`,
    });

    this.logger.warn(
      `Snapshot ${snapshot.sequence} restated invoice ${reservation.invoiceId}: ` +
        `${previous.toDecimalString()} -> ${listedAmount.toDecimalString()}`,
    );
  }

  private async recreateReservation(
    manager: EntityManager,
    program: ProgramEntity,
    item: OpenReservationDto,
    asOf: Date,
    correlationId: string,
    snapshot: TreasuryReconciliationDto,
  ): Promise<void> {
    const amount = Money.fromMoneyLike(item.amount);

    const reservation = await manager.save(
      InvoiceReservationEntity,
      manager.create(InvoiceReservationEntity, {
        programId: program.id,
        invoiceId: item.invoiceId,
        status: ReservationStatus.Reserved,
        invoiceAmountMinor: amount.minorUnits,
        invoiceCurrency: program.currency,
        reservedAmountMinor: amount.minorUnits,
        programCurrency: program.currency,
        fxRate: '1',
        fxRateSource: 'RECONCILIATION',
        fxRateAt: asOf,
        source: ReservationSource.Treasury,
        reservedAt: asOf,
        metadata: { recreatedFromSnapshot: snapshot.sequence },
      }),
    );

    await this.ledger.append(manager, {
      program,
      entryType: LedgerEntryType.ReconciliationAdjustment,
      source: LedgerEntrySource.TreasuryReconciliation,
      actor: TREASURY_ACTOR,
      reservedDelta: 0n,
      reservationId: reservation.id,
      correlationId,
      occurredAt: asOf,
      reason: `Recreated reservation for invoice ${item.invoiceId} from snapshot ${snapshot.sequence}`,
    });

    this.logger.warn(
      `Snapshot ${snapshot.sequence} contained invoice ${item.invoiceId}, which was missing locally`,
    );
  }

  /** Closes treasury reservations the snapshot no longer lists. */
  private async closeReservationsMissingFrom(
    manager: EntityManager,
    program: ProgramEntity,
    listedByInvoice: Map<string, OpenReservationDto>,
    asOf: Date,
    correlationId: string,
    snapshot: TreasuryReconciliationDto,
  ): Promise<void> {
    const openTreasuryRows = await manager.find(InvoiceReservationEntity, {
      where: {
        programId: program.id,
        source: ReservationSource.Treasury,
        status: ReservationStatus.Reserved,
      },
    });

    for (const row of openTreasuryRows) {
      if (listedByInvoice.has(row.invoiceId)) continue;
      // Opened after the snapshot was taken, so its absence means nothing.
      if (row.reservedAt.getTime() > asOf.getTime()) continue;

      row.status = ReservationStatus.Cancelled;
      row.cancelledAt = asOf;
      await manager.save(InvoiceReservationEntity, row);

      await this.ledger.append(manager, {
        program,
        entryType: LedgerEntryType.ReconciliationAdjustment,
        source: LedgerEntrySource.TreasuryReconciliation,
        actor: TREASURY_ACTOR,
        reservedDelta: 0n,
        reservationId: row.id,
        correlationId,
        occurredAt: asOf,
        reason: `Closed reservation for invoice ${row.invoiceId}: absent from snapshot ${snapshot.sequence}`,
      });

      this.logger.warn(
        `Snapshot ${snapshot.sequence} no longer lists invoice ${row.invoiceId}; closed it locally`,
      );
    }
  }

  /**
   * Sums the movements the snapshot cannot have seen, by when they happened.
   *
   * Timing decides this, not who created the reservation. A reservation opened
   * after `asOf` is absent from the snapshot whoever opened it, and one the
   * snapshot counts is gone whoever closed it — a treasury-created reservation
   * released through this API is the case a `source` filter gets wrong.
   */
  private async localMovementsSince(
    manager: EntityManager,
    program: ProgramEntity,
    asOf: Date,
  ): Promise<{ opened: bigint; closed: bigint }> {
    const opened = await manager
      .createQueryBuilder(InvoiceReservationEntity, 'reservation')
      .select('COALESCE(SUM(reservation.reserved_amount_minor), 0)', 'total')
      .where('reservation.program_id = :programId', { programId: program.id })
      .andWhere('reservation.status = :status', { status: ReservationStatus.Reserved })
      .andWhere('reservation.reserved_at > :asOf', { asOf })
      .getRawOne<{ total: string }>();

    const closed = await manager
      .createQueryBuilder(InvoiceReservationEntity, 'reservation')
      .select('COALESCE(SUM(reservation.reserved_amount_minor), 0)', 'total')
      .where('reservation.program_id = :programId', { programId: program.id })
      .andWhere('reservation.status IN (:...statuses)', {
        statuses: [ReservationStatus.Released, ReservationStatus.Cancelled],
      })
      .andWhere('reservation.reserved_at <= :asOf', { asOf })
      .andWhere('COALESCE(reservation.released_at, reservation.cancelled_at) > :asOf', { asOf })
      .getRawOne<{ total: string }>();

    return { opened: BigInt(opened?.total ?? 0), closed: BigInt(closed?.total ?? 0) };
  }

  /**
   * A snapshot carrying detail must agree with itself.
   *
   * The rows are rebuilt from `openReservations` and the balance is checked
   * against `reservedTotal`. If those two disagree the message contains two
   * different claims about the same thing, and applying either one leaves the
   * program in a state the producer never described. That is a producer bug, so
   * it is parked rather than half-applied.
   */
  private assertSnapshotIsConsistent(
    snapshot: TreasuryReconciliationDto,
    reservedTotal: Money,
  ): void {
    const listed = snapshot.openReservations;
    if (listed === undefined) return;

    const violations: string[] = [];

    const seen = new Set<string>();
    for (const item of listed) {
      if (seen.has(item.invoiceId)) {
        violations.push(`openReservations lists invoice ${item.invoiceId} more than once`);
      }
      seen.add(item.invoiceId);
    }

    const sum = listed.reduce(
      (total, item) => total + MoneyDto.toMoney(item.amount).minorUnits,
      0n,
    );

    if (sum !== reservedTotal.minorUnits) {
      violations.push(
        `openReservations sum to ${sum} minor units but reservedTotal is ${reservedTotal.minorUnits}`,
      );
    }

    if (violations.length > 0) {
      throw new MalformedMessageError(this.topic, violations);
    }
  }

  /** Sums everything still held open for the program. */
  private async openReservationsTotal(
    manager: EntityManager,
    program: ProgramEntity,
  ): Promise<bigint> {
    const row = await manager
      .createQueryBuilder(InvoiceReservationEntity, 'reservation')
      .select('COALESCE(SUM(reservation.reserved_amount_minor), 0)', 'total')
      .where('reservation.program_id = :programId', { programId: program.id })
      .andWhere('reservation.status = :status', { status: ReservationStatus.Reserved })
      .getRawOne<{ total: string }>();

    return BigInt(row?.total ?? 0);
  }
}
