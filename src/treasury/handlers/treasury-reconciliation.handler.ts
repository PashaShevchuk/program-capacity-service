import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { EntityManager } from 'typeorm';

import { CurrencyMismatchError } from '../../common/errors/domain.errors';
import { MoneyDto } from '../../common/money/money.dto';
import { Money } from '../../common/money/money';
import { kafkaConfig } from '../../config/configuration';
import { KafkaHandlerRegistry } from '../../kafka/kafka-handler.registry';
import {
  type AfterCommit,
  type KafkaMessageHandler,
  type ParsedKafkaMessage,
} from '../../kafka/kafka-message';
import { LedgerEntrySource, LedgerEntryType } from '../../ledger/capacity-ledger-entry.entity';
import { LedgerService } from '../../ledger/ledger.service';
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
import { TreasuryReconciliationDto } from '../dto/treasury-messages.dto';
import { parseMessageBody } from '../message-validation';
import { isStaleSequence, reconcileCapacity } from '../reconciliation.calculator';

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

    const snapshotLimit = MoneyDto.toMoney(snapshot.totalLimit);
    const snapshotReserved = MoneyDto.toMoney(snapshot.reservedTotal);

    if (
      snapshotLimit.currency !== program.currency ||
      snapshotReserved.currency !== program.currency
    ) {
      throw new CurrencyMismatchError(program.currency, snapshotLimit.currency);
    }

    this.warnOnInconsistentSnapshot(snapshot, snapshotReserved);

    const asOf = new Date(snapshot.asOf);
    const local = await this.localMovementsSince(manager, program, asOf);

    const outcome = reconcileCapacity({
      snapshotReservedMinor: snapshotReserved.minorUnits,
      snapshotLimitMinor: snapshotLimit.minorUnits,
      currentReservedMinor: program.reservedMinor,
      currentLimitMinor: program.totalLimitMinor,
      openedLocallyAfterSnapshotMinor: local.opened,
      closedLocallyAfterSnapshotMinor: local.closed,
    });

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
    return () => this.capacityEvents.publish(payload);
  }

  /**
   * Sums the local reservations the snapshot cannot have seen.
   *
   * Only API-sourced rows count: anything mirrored from treasury is already
   * reflected in the snapshot's own total.
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
      .andWhere('reservation.source = :source', { source: ReservationSource.Api })
      .andWhere('reservation.status = :status', { status: ReservationStatus.Reserved })
      .andWhere('reservation.reserved_at > :asOf', { asOf })
      .getRawOne<{ total: string }>();

    const closed = await manager
      .createQueryBuilder(InvoiceReservationEntity, 'reservation')
      .select('COALESCE(SUM(reservation.reserved_amount_minor), 0)', 'total')
      .where('reservation.program_id = :programId', { programId: program.id })
      .andWhere('reservation.source = :source', { source: ReservationSource.Api })
      .andWhere('reservation.status IN (:...statuses)', {
        statuses: [ReservationStatus.Released, ReservationStatus.Cancelled],
      })
      .andWhere('reservation.reserved_at <= :asOf', { asOf })
      .andWhere('COALESCE(reservation.released_at, reservation.cancelled_at) > :asOf', { asOf })
      .getRawOne<{ total: string }>();

    return { opened: BigInt(opened?.total ?? 0), closed: BigInt(closed?.total ?? 0) };
  }

  /** A snapshot whose detail disagrees with its own total is worth knowing about. */
  private warnOnInconsistentSnapshot(
    snapshot: TreasuryReconciliationDto,
    reservedTotal: Money,
  ): void {
    if (!snapshot.openReservations?.length) return;

    const sum = snapshot.openReservations.reduce(
      (total, item) => total + MoneyDto.toMoney(item.amount).minorUnits,
      0n,
    );

    if (sum !== reservedTotal.minorUnits) {
      this.logger.warn(
        `Snapshot ${snapshot.sequence} for ${snapshot.programCode} lists ${sum} minor units of ` +
          `open reservations but reports a total of ${reservedTotal.minorUnits}; using the reported total`,
      );
    }
  }
}
