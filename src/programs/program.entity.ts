import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Money } from '../common/money';
import { bigintTransformer } from '../common/money';

export enum ProgramStatus {
  /** Accepts new reservations. */
  Active = 'ACTIVE',
  /** Existing reservations may be released, but no new ones are accepted. */
  Suspended = 'SUSPENDED',
  /** Terminal state; no capacity movements accepted from the API. */
  Closed = 'CLOSED',
}

/**
 * A financing program and its credit capacity.
 *
 * `reservedMinor` is a running total rather than a SUM over the ledger, because
 * reading availability is the hottest path here and must not scan a table that
 * grows forever. Every write to it happens in the same transaction as the
 * ledger entry that explains it.
 */
@Entity('programs')
export class ProgramEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Business identifier shared with the treasury system and clients. */
  @Index('uq_programs_code', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** Currency the capacity is accounted in. */
  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ name: 'total_limit_minor', type: 'bigint', transformer: bigintTransformer })
  totalLimitMinor: bigint;

  @Column({
    name: 'reserved_minor',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  reservedMinor: bigint;

  @Column({ type: 'varchar', length: 16, default: ProgramStatus.Active })
  status: ProgramStatus;

  /**
   * Bumped on every capacity movement so clients can tell a stale snapshot.
   * Set explicitly by our SQL rather than `@VersionColumn`, because the hot
   * path updates this row through the query builder, not `save()`.
   */
  @Column({ type: 'integer', default: 0 })
  version: number;

  /**
   * Highest treasury sequence applied. Messages with a lower or equal sequence
   * are stale and ignored, since Kafka only orders within a partition.
   */
  @Column({
    name: 'last_treasury_sequence',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  lastTreasurySequence: bigint | null;

  @Column({ name: 'last_reconciled_at', type: 'timestamptz', nullable: true })
  lastReconciledAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // --- domain accessors -----------------------------------------------------

  get totalLimit(): Money {
    return Money.fromMinorUnits(this.totalLimitMinor, this.currency);
  }

  get reserved(): Money {
    return Money.fromMinorUnits(this.reservedMinor, this.currency);
  }

  /** Capacity left to reserve. Negative if treasury reports an overcommit. */
  get available(): Money {
    return this.totalLimit.subtract(this.reserved);
  }

  /** Reservations exceed the limit. Only reachable via treasury reconciliation. */
  get isOvercommitted(): boolean {
    return this.reservedMinor > this.totalLimitMinor;
  }

  get acceptsNewReservations(): boolean {
    return this.status === ProgramStatus.Active;
  }
}
