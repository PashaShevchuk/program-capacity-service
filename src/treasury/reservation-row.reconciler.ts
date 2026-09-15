import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { MalformedMessageError } from '../common/errors/domain.errors';
import { Money } from '../common/money/money';
import { LedgerEntrySource, LedgerEntryType } from '../ledger/capacity-ledger-entry.entity';
import { TREASURY_ACTOR } from '../ledger/ledger-actor';
import { LedgerService } from '../ledger/ledger.service';
import { type ProgramEntity } from '../programs/program.entity';
import {
  InvoiceReservationEntity,
  ReservationSource,
  ReservationStatus,
} from '../reservations/invoice-reservation.entity';
import { OpenReservationDto, TreasuryReconciliationDto } from './dto/treasury-messages.dto';

@Injectable()
export class ReservationRowReconciler {
  private readonly logger = new Logger(ReservationRowReconciler.name);

  constructor(private readonly ledger: LedgerService) {}

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
  async apply(
    manager: EntityManager,
    program: ProgramEntity,
    snapshot: TreasuryReconciliationDto,
    asOf: Date,
    correlationId: string,
    topic: string,
  ): Promise<void> {
    const listed = snapshot.openReservations;

    // An omitted list means the snapshot says nothing about individual rows.
    // An empty one means treasury holds nothing open, which is a statement.
    if (listed === undefined) return;

    const wrongCurrency = listed.filter((item) => item.amount.currency !== program.currency);
    if (wrongCurrency.length > 0) {
      // The contract says these are quoted in the program's own currency; the
      // snapshot carries no rate, so there is nothing to convert them with.
      throw new MalformedMessageError(topic, [
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
        await this.recreate(manager, program, item, asOf, correlationId, snapshot);
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
        await this.restate(manager, program, existing, listedAmount, asOf, correlationId, snapshot);
      }
    }

    await this.closeMissing(manager, program, listedByInvoice, asOf, correlationId, snapshot);
  }

  /** Moves an open row onto the figure treasury reports for it. */
  private async restate(
    manager: EntityManager,
    program: ProgramEntity,
    reservation: InvoiceReservationEntity,
    listedAmount: Money,
    asOf: Date,
    correlationId: string,
    snapshot: TreasuryReconciliationDto,
  ): Promise<void> {
    const previous = reservation.reservedAmount;

    // Only what the program currently holds changes. The invoice's face value
    // and the rate frozen when it was approved are the evidence for how the
    // original figure was reached, and overwriting them would leave the
    // reservation unable to explain itself.
    reservation.reservedAmountMinor = listedAmount.minorUnits;
    reservation.metadata = {
      ...reservation.metadata,
      restatedBySnapshot: snapshot.sequence,
      amountBeforeRestatement: previous.toDecimalString(),
    };
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

  private async recreate(
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
  private async closeMissing(
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

  /** Sums everything still held open for the program. */
  async openTotal(manager: EntityManager, program: ProgramEntity): Promise<bigint> {
    const row = await manager
      .createQueryBuilder(InvoiceReservationEntity, 'reservation')
      .select('COALESCE(SUM(reservation.reserved_amount_minor), 0)', 'total')
      .where('reservation.program_id = :programId', { programId: program.id })
      .andWhere('reservation.status = :status', { status: ReservationStatus.Reserved })
      .getRawOne<{ total: string }>();

    return BigInt(row?.total ?? 0);
  }
}
