import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { Money } from '../common/money';
import { bigintTransformer } from '../common/money';
import { type LedgerActor, LedgerActorType } from './ledger-actor';

export enum LedgerEntryType {
  /** Capacity taken by an approved invoice. */
  Reserve = 'RESERVE',
  /** Capacity returned after repayment. */
  Release = 'RELEASE',
  /** Capacity returned because the reservation was withdrawn. */
  Cancel = 'CANCEL',
  /** The program's total credit limit changed. */
  LimitChange = 'LIMIT_CHANGE',
  /** Difference between local state and a treasury reconciliation snapshot. */
  ReconciliationAdjustment = 'RECONCILIATION_ADJUSTMENT',
}

export enum LedgerEntrySource {
  Api = 'API',
  TreasuryEvent = 'TREASURY_EVENT',
  TreasuryReconciliation = 'TREASURY_RECONCILIATION',
  System = 'SYSTEM',
}

/**
 * Append-only audit trail of capacity movements. Nothing updates or deletes rows here.
 *
 * Each entry stores the delta and the balances after it, so any point in time
 * can be read from one row, and drift against `programs.reserved_minor` shows up.
 */
@Entity('capacity_ledger_entries')
@Index('idx_ledger_program_keyset', ['programId', 'createdAt', 'id'])
@Index('idx_ledger_reservation', ['reservationId'])
export class CapacityLedgerEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'program_id', type: 'uuid' })
  programId: string;

  @Column({ name: 'reservation_id', type: 'uuid', nullable: true })
  reservationId: string | null;

  @Column({ name: 'entry_type', type: 'varchar', length: 32 })
  entryType: LedgerEntryType;

  @Column({ type: 'varchar', length: 32 })
  source: LedgerEntrySource;

  @Column({ type: 'char', length: 3 })
  currency: string;

  /** Signed change to the reserved total; positive takes capacity. */
  @Column({
    name: 'reserved_delta_minor',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  reservedDeltaMinor: bigint;

  /** Signed change to the total credit limit. */
  @Column({ name: 'limit_delta_minor', type: 'bigint', default: 0, transformer: bigintTransformer })
  limitDeltaMinor: bigint;

  /** Reserved total after this entry was applied. */
  @Column({ name: 'reserved_after_minor', type: 'bigint', transformer: bigintTransformer })
  reservedAfterMinor: bigint;

  /** Credit limit after this entry was applied. */
  @Column({ name: 'limit_after_minor', type: 'bigint', transformer: bigintTransformer })
  limitAfterMinor: bigint;

  /** Why this entry exists, e.g. what a reconciliation corrected. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ name: 'actor_type', type: 'varchar', length: 16, default: LedgerActorType.System })
  actorType: LedgerActorType;

  @Column({ name: 'actor_id', type: 'varchar', length: 128, nullable: true })
  actorId: string | null;

  /** How the actor was identified when the entry was written. */
  @Column({ name: 'actor_label', type: 'varchar', length: 320, nullable: true })
  actorLabel: string | null;

  /** HTTP request id or Kafka message id that caused this entry. */
  @Index('idx_ledger_correlation_id')
  @Column({ name: 'correlation_id', type: 'varchar', length: 128, nullable: true })
  correlationId: string | null;

  /** When the business event happened; can be earlier than `createdAt`. */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt: Date;

  get reservedDelta(): Money {
    return Money.fromMinorUnits(this.reservedDeltaMinor, this.currency);
  }

  get reservedAfter(): Money {
    return Money.fromMinorUnits(this.reservedAfterMinor, this.currency);
  }

  get limitAfter(): Money {
    return Money.fromMinorUnits(this.limitAfterMinor, this.currency);
  }

  get availableAfter(): Money {
    return this.limitAfter.subtract(this.reservedAfter);
  }

  get actor(): LedgerActor {
    return { type: this.actorType, id: this.actorId, label: this.actorLabel };
  }
}
