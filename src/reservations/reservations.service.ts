import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';

import {
  DuplicateReservationError,
  IdempotencyKeyConflictError,
  InsufficientCapacityError,
  InvalidIdempotencyKeyError,
  InvalidTimestampError,
  InvalidReservationTransitionError,
  ProgramNotActiveError,
  ReservationNotFoundError,
} from '../common/errors/domain.errors';
import { type Money } from '../common/money';
import {
  buildCursorPage,
  type CursorPageDto,
  type CursorQueryDto,
} from '../common/pagination/cursor-pagination.dto';
import { applyKeyset } from '../common/pagination/keyset';
import { kafkaConfig } from '../config/configuration';
import { isUniqueViolation } from '../database/postgres-errors';
import { type ConversionResult } from '../fx/currency-converter';
import { FxService } from '../fx/fx.service';
import { LedgerEntryType } from '../ledger/capacity-ledger-entry.entity';
import { LedgerService } from '../ledger/ledger.service';
import { MetricsService } from '../metrics/metrics.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  CAPACITY_CHANGED_EVENT_TYPE,
  buildCapacityChangedPayload,
} from '../programs/capacity-changed.event';
import { CapacityEventsService } from '../programs/capacity-events.service';
import { ProgramCapacityRepository } from '../programs/program-capacity.repository';
import { type ProgramEntity } from '../programs/program.entity';
import { InvoiceReservationEntity, ReservationStatus } from './invoice-reservation.entity';
import {
  type CloseReservationCommand,
  type ReservationResult,
  type ReserveCapacityCommand,
} from './reservation.commands';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Matches the `idempotency_key` column. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** Clock skew allowed on a caller-supplied timestamp. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

type ClosingStatus = ReservationStatus.Released | ReservationStatus.Cancelled;

/**
 * Reserves and releases program capacity.
 *
 * Every movement follows the same shape: lock the program row, check the
 * invariants, then write the program, the ledger entry and the outbox event
 * together. The `*Within` methods take a caller's transaction, which is what
 * lets Kafka handlers apply a change and record the message as consumed
 * atomically.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly programs: ProgramCapacityRepository,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly fx: FxService,
    private readonly capacityEvents: CapacityEventsService,
    private readonly metrics: MetricsService,
    @Inject(kafkaConfig.KEY) private readonly kafka: ConfigType<typeof kafkaConfig>,
  ) {}

  // --- queries --------------------------------------------------------------

  async list(
    programRef: string,
    query: CursorQueryDto,
  ): Promise<CursorPageDto<InvoiceReservationEntity>> {
    const program = await this.programs.findProgram(this.dataSource.manager, programRef);

    const rows = await applyKeyset(
      this.dataSource.manager
        .createQueryBuilder(InvoiceReservationEntity, 'reservation')
        .where('reservation.program_id = :programId', { programId: program.id }),
      {
        alias: 'reservation',
        timestampColumn: 'reserved_at',
        limit: query.limit,
        cursor: query.cursor,
      },
    ).getMany();

    return buildCursorPage(rows, query.limit, (reservation) => reservation.reservedAt);
  }

  async findOne(programRef: string, reservationRef: string): Promise<InvoiceReservationEntity> {
    const program = await this.programs.findProgram(this.dataSource.manager, programRef);

    return this.findReservation(this.dataSource.manager, program.id, reservationRef);
  }

  // --- commands -------------------------------------------------------------

  async reserve(command: ReserveCapacityCommand): Promise<ReservationResult> {
    // Read the rate before opening the transaction so the row lock is held for
    // as short a time as possible.
    const program = await this.programs.findProgram(this.dataSource.manager, command.programRef);
    const conversion = await this.fx.convert(
      command.amount,
      program.currency,
      command.occurredAt ?? new Date(),
    );

    let result: ReservationResult;
    try {
      result = await this.dataSource.transaction((manager) =>
        this.reserveWithin(manager, command, conversion),
      );
    } catch (error) {
      this.metrics.recordReservationOutcome(program.code, 'rejected');
      throw error;
    }

    this.metrics.recordReservationOutcome(program.code, result.changed ? 'accepted' : 'replayed');
    this.announce(result, 'RESERVE');

    return result;
  }

  async release(command: CloseReservationCommand): Promise<ReservationResult> {
    const result = await this.dataSource.transaction((manager) =>
      this.closeWithin(manager, command, ReservationStatus.Released),
    );

    this.announce(result, ReservationStatus.Released);

    return result;
  }

  async cancel(command: CloseReservationCommand): Promise<ReservationResult> {
    const result = await this.dataSource.transaction((manager) =>
      this.closeWithin(manager, command, ReservationStatus.Cancelled),
    );

    this.announce(result, ReservationStatus.Cancelled);

    return result;
  }

  // --- transaction bodies ---------------------------------------------------

  async reserveWithin(
    manager: EntityManager,
    command: ReserveCapacityCommand,
    precomputed?: ConversionResult,
  ): Promise<ReservationResult> {
    const occurredAt = command.occurredAt ?? new Date();
    assertNotInFuture(occurredAt, 'approvedAt');

    const program = await this.programs.lockProgram(manager, command.programRef);

    const replay = await this.findIdempotentReplay(manager, program, command);
    if (replay) {
      return { reservation: replay, program, changed: false };
    }

    if (!program.acceptsNewReservations) {
      throw new ProgramNotActiveError(program.code, program.status);
    }

    const conversion =
      precomputed ?? (await this.fx.convert(command.amount, program.currency, occurredAt));
    const required = conversion.amount;

    // A treasury reserve reports something that already happened at the source
    // of truth. Refusing it would leave the two permanently out of step, and a
    // snapshot can overcommit a program anyway, so it is allowed through and
    // surfaced as `overcommitted`.
    if (!command.allowOvercommit && program.available.isLessThan(required)) {
      throw new InsufficientCapacityError({
        programId: program.code,
        currency: program.currency,
        requestedAmount: required.toDecimalString(),
        availableAmount: program.available.toDecimalString(),
      });
    }

    const reservation = await this.insertReservation(manager, program, command, required, {
      rate: conversion.rate.rate,
      source: conversion.rate.source,
      asOf: conversion.rate.asOf,
      reservedAt: occurredAt,
    });

    await this.programs.applyChange(manager, program, { reservedDelta: required.minorUnits });

    await this.ledger.append(manager, {
      program,
      entryType: LedgerEntryType.Reserve,
      source: command.ledgerSource,
      actor: command.actor,
      reservedDelta: required.minorUnits,
      reservationId: reservation.id,
      correlationId: command.correlationId,
      occurredAt,
      reason: `Invoice ${command.invoiceId} approved for early payment`,
      metadata: {
        invoiceAmount: command.amount.toJSON(),
        fxRate: conversion.rate.rate,
        fxRateSource: conversion.rate.source,
      },
    });

    await this.enqueueCapacityChanged(manager, program, 'RESERVE', reservation.id);

    return { reservation, program, changed: true };
  }

  async closeWithin(
    manager: EntityManager,
    command: CloseReservationCommand,
    target: ClosingStatus,
  ): Promise<ReservationResult> {
    const occurredAt = command.occurredAt ?? new Date();
    assertNotInFuture(occurredAt, 'occurredAt');

    const program = await this.programs.lockProgram(manager, command.programRef);
    const reservation = await this.findReservation(manager, program.id, command.reservationRef);

    if (occurredAt.getTime() < reservation.reservedAt.getTime()) {
      throw new InvalidTimestampError('A reservation cannot close before it was made', {
        occurredAt: occurredAt.toISOString(),
        reservedAt: reservation.reservedAt.toISOString(),
      });
    }

    // Repayment notifications get retried. A reservation already in the target
    // state is the outcome the caller wanted, so report success and stop.
    if (reservation.status === target) {
      return { reservation, program, changed: false };
    }

    // Reconciliation may have closed the row already. Treasury reporting the
    // release afterwards is not a conflict, it is the same outcome.
    if (command.allowAlreadyClosed && !reservation.isOpen) {
      this.logger.log(
        `Reservation for invoice ${reservation.invoiceId} is already ${reservation.status}; treating the release as applied`,
      );
      return { reservation, program, changed: false };
    }

    if (!reservation.canTransitionTo(target)) {
      throw new InvalidReservationTransitionError({
        reservationId: reservation.id,
        from: reservation.status,
        to: target,
      });
    }

    // Return exactly what was taken, not a fresh conversion of the invoice.
    const returned = reservation.reservedAmount;

    reservation.status = target;
    if (target === ReservationStatus.Released) {
      reservation.releasedAt = occurredAt;
    } else {
      reservation.cancelledAt = occurredAt;
    }
    await manager.save(InvoiceReservationEntity, reservation);

    await this.programs.applyChange(manager, program, { reservedDelta: -returned.minorUnits });

    await this.ledger.append(manager, {
      program,
      entryType:
        target === ReservationStatus.Released ? LedgerEntryType.Release : LedgerEntryType.Cancel,
      source: command.ledgerSource,
      actor: command.actor,
      reservedDelta: -returned.minorUnits,
      reservationId: reservation.id,
      correlationId: command.correlationId,
      occurredAt,
      reason:
        command.reason ??
        (target === ReservationStatus.Released
          ? `Invoice ${reservation.invoiceId} repaid`
          : `Reservation for invoice ${reservation.invoiceId} cancelled`),
    });

    await this.enqueueCapacityChanged(manager, program, target, reservation.id);

    return { reservation, program, changed: true };
  }

  /** Publishes to SSE subscribers. Call only after the transaction committed. */
  announce(result: ReservationResult, reason: string): void {
    if (!result.changed) return;

    this.metrics.recordCapacity(result.program);
    this.capacityEvents.publish(
      buildCapacityChangedPayload(result.program, reason, result.reservation.id),
    );

    this.logger.log(
      `${reason} ${result.reservation.reservedAmount.toString()} on ${result.program.code} ` +
        `for invoice ${result.reservation.invoiceId}`,
    );
  }

  // --- helpers --------------------------------------------------------------

  /**
   * Returns the existing reservation when this request was already applied.
   *
   * A replay is identified either by the client's `Idempotency-Key` or by the
   * invoice itself, since an invoice holds at most one reservation per program.
   * A key reused for a different request is a client bug, not a replay.
   */
  private async findIdempotentReplay(
    manager: EntityManager,
    program: ProgramEntity,
    command: ReserveCapacityCommand,
  ): Promise<InvoiceReservationEntity | null> {
    const fingerprint = fingerprintOf(program.id, command);

    if (command.idempotencyKey) {
      if (command.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new InvalidIdempotencyKeyError(MAX_IDEMPOTENCY_KEY_LENGTH);
      }

      const byKey = await manager.findOne(InvoiceReservationEntity, {
        where: { idempotencyKey: command.idempotencyKey },
      });

      if (byKey) {
        // Same key must mean the same request. Returning the original for a
        // different amount would tell the caller their new figure was reserved.
        if (byKey.requestFingerprint !== fingerprint) {
          throw new IdempotencyKeyConflictError(command.idempotencyKey);
        }
        return byKey;
      }
    }

    const byInvoice = await manager.findOne(InvoiceReservationEntity, {
      where: { programId: program.id, invoiceId: command.invoiceId },
    });

    if (!byInvoice) {
      return null;
    }

    const sameRequest =
      byInvoice.status === ReservationStatus.Reserved &&
      byInvoice.invoiceAmountMinor === command.amount.minorUnits &&
      byInvoice.invoiceCurrency === command.amount.currency;

    if (!sameRequest) {
      throw new DuplicateReservationError({
        programId: program.code,
        invoiceId: command.invoiceId,
        reservationId: byInvoice.id,
      });
    }

    return byInvoice;
  }

  private async insertReservation(
    manager: EntityManager,
    program: ProgramEntity,
    command: ReserveCapacityCommand,
    reservedAmount: Money,
    fx: { rate: string; source: string; asOf: Date; reservedAt: Date },
  ): Promise<InvoiceReservationEntity> {
    const reservation = manager.create(InvoiceReservationEntity, {
      programId: program.id,
      invoiceId: command.invoiceId,
      status: ReservationStatus.Reserved,
      invoiceAmountMinor: command.amount.minorUnits,
      invoiceCurrency: command.amount.currency,
      reservedAmountMinor: reservedAmount.minorUnits,
      programCurrency: program.currency,
      fxRate: fx.rate,
      fxRateSource: fx.source,
      fxRateAt: fx.asOf,
      source: command.source,
      idempotencyKey: command.idempotencyKey ?? null,
      externalReference: command.externalReference ?? null,
      reservedAt: fx.reservedAt,
      requestFingerprint: fingerprintOf(program.id, command),
      metadata: command.metadata ?? {},
    });

    try {
      return await manager.save(InvoiceReservationEntity, reservation);
    } catch (error) {
      if (
        command.idempotencyKey &&
        isUniqueViolation(error, 'uq_invoice_reservations_idempotency_key')
      ) {
        throw new IdempotencyKeyConflictError(command.idempotencyKey);
      }
      if (isUniqueViolation(error, 'uq_invoice_reservations_program_invoice')) {
        throw new DuplicateReservationError({
          programId: program.code,
          invoiceId: command.invoiceId,
          reservationId: 'unknown',
        });
      }
      throw error;
    }
  }

  private async findReservation(
    manager: EntityManager,
    programId: string,
    reference: string,
  ): Promise<InvoiceReservationEntity> {
    const reservation = await manager.findOne(InvoiceReservationEntity, {
      where: UUID_PATTERN.test(reference)
        ? { id: reference, programId }
        : { invoiceId: reference, programId },
    });

    if (!reservation) {
      throw new ReservationNotFoundError(reference);
    }

    return reservation;
  }

  private enqueueCapacityChanged(
    manager: EntityManager,
    program: ProgramEntity,
    reason: string,
    reservationId: string | null,
  ): Promise<string> {
    return this.outbox.enqueue(manager, {
      topic: this.kafka.topics.capacityChanged,
      messageKey: program.id,
      eventType: CAPACITY_CHANGED_EVENT_TYPE,
      payload: buildCapacityChangedPayload(program, reason, reservationId),
    });
  }
}

/**
 * Canonical hash of what a reservation request asked for. Two requests with the
 * same idempotency key must hash the same, or the second one is a different
 * request wearing a used key.
 */
function fingerprintOf(programId: string, command: ReserveCapacityCommand): string {
  const canonical = JSON.stringify({
    programId,
    invoiceId: command.invoiceId,
    minorUnits: command.amount.minorUnits.toString(),
    currency: command.amount.currency,
    // The approval time picks the FX rate, so two requests that differ only
    // here can reserve different amounts of capacity. `null` when the caller
    // omitted it, so a default of "now" does not make every retry look new.
    occurredAt: command.occurredAt?.toISOString() ?? null,
    externalReference: command.externalReference ?? null,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

function assertNotInFuture(moment: Date, field: string): void {
  if (moment.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new InvalidTimestampError(`${field} is too far in the future`, {
      [field]: moment.toISOString(),
      maxSkewMs: MAX_CLOCK_SKEW_MS,
    });
  }
}
