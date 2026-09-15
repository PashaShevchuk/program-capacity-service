import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Money } from '../common/money';
import { bigintTransformer } from '../common/money';
import { ProgramEntity } from '../programs/program.entity';

export enum ReservationStatus {
  /** Capacity is held for this invoice. */
  Reserved = 'RESERVED',
  /** The invoice was repaid; capacity has been returned to the program. */
  Released = 'RELEASED',
  /** The reservation was withdrawn before repayment; capacity returned. */
  Cancelled = 'CANCELLED',
}

export enum ReservationSource {
  /** Created through this service's HTTP API. */
  Api = 'API',
  /** Mirrored from the external treasury system over Kafka. */
  Treasury = 'TREASURY',
}

/** Allowed lifecycle transitions. Anything else is rejected. */
export const ALLOWED_RESERVATION_TRANSITIONS: Readonly<
  Record<ReservationStatus, readonly ReservationStatus[]>
> = Object.freeze({
  [ReservationStatus.Reserved]: [ReservationStatus.Released, ReservationStatus.Cancelled],
  [ReservationStatus.Released]: [],
  [ReservationStatus.Cancelled]: [],
});

/**
 * Capacity held against a program for one invoice.
 *
 * The invoice may be in a different currency than the program. The amount
 * charged against capacity and the rate used are frozen at reservation time,
 * and releasing returns exactly that amount, so a moving FX rate cannot make
 * capacity drift.
 */
@Entity('invoice_reservations')
@Index('uq_invoice_reservations_program_invoice', ['programId', 'invoiceId'], { unique: true })
@Index('idx_invoice_reservations_program_status', ['programId', 'status'])
@Index('idx_invoice_reservations_program_keyset', ['programId', 'reservedAt', 'id'])
export class InvoiceReservationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'program_id', type: 'uuid' })
  programId: string;

  @ManyToOne(() => ProgramEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'program_id' })
  program?: ProgramEntity;

  /**
   * Client's invoice id, unique per program. This makes the reservation its own
   * idempotency record: re-approving an invoice returns the existing one.
   */
  @Column({ name: 'invoice_id', type: 'varchar', length: 128 })
  invoiceId: string;

  @Column({ type: 'varchar', length: 16, default: ReservationStatus.Reserved })
  status: ReservationStatus;

  // --- amounts --------------------------------------------------------------

  /** Face value of the invoice, in the invoice's own currency. */
  @Column({ name: 'invoice_amount_minor', type: 'bigint', transformer: bigintTransformer })
  invoiceAmountMinor: bigint;

  @Column({ name: 'invoice_currency', type: 'char', length: 3 })
  invoiceCurrency: string;

  /** Amount charged against capacity, in the program's currency. */
  @Column({ name: 'reserved_amount_minor', type: 'bigint', transformer: bigintTransformer })
  reservedAmountMinor: bigint;

  @Column({ name: 'program_currency', type: 'char', length: 3 })
  programCurrency: string;

  // --- frozen FX context ----------------------------------------------------

  /** Invoice currency -> program currency at `fxRateAt`. 1 when they match. */
  @Column({ name: 'fx_rate', type: 'numeric', precision: 24, scale: 12 })
  fxRate: string;

  @Column({ name: 'fx_rate_source', type: 'varchar', length: 64 })
  fxRateSource: string;

  @Column({ name: 'fx_rate_at', type: 'timestamptz' })
  fxRateAt: Date;

  // --- provenance -----------------------------------------------------------

  @Column({ type: 'varchar', length: 16, default: ReservationSource.Api })
  source: ReservationSource;

  /** Client `Idempotency-Key`; unique so a retried POST cannot reserve twice. */
  @Index('uq_invoice_reservations_idempotency_key', {
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  /** Hash of the body the idempotency key was first used with. */
  @Column({ name: 'request_fingerprint', type: 'varchar', length: 64, nullable: true })
  requestFingerprint: string | null;

  /** Treasury's id for this reservation, when mirrored from Kafka. */
  @Column({ name: 'external_reference', type: 'varchar', length: 128, nullable: true })
  externalReference: string | null;

  // --- lifecycle timestamps -------------------------------------------------

  /** Millisecond precision, so a cursor built from this value is exact. */
  @Column({ name: 'reserved_at', type: 'timestamptz', precision: 3 })
  reservedAt: Date;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // --- domain accessors -----------------------------------------------------

  get invoiceAmount(): Money {
    return Money.fromMinorUnits(this.invoiceAmountMinor, this.invoiceCurrency);
  }

  /** Amount returned to the program when this reservation closes. */
  get reservedAmount(): Money {
    return Money.fromMinorUnits(this.reservedAmountMinor, this.programCurrency);
  }

  get isOpen(): boolean {
    return this.status === ReservationStatus.Reserved;
  }

  canTransitionTo(target: ReservationStatus): boolean {
    return ALLOWED_RESERVATION_TRANSITIONS[this.status].includes(target);
  }
}
