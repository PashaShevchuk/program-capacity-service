import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One rate observation: 1 `baseCurrency` = `rate` `quoteCurrency`.
 * Stored as `numeric`, never a float, and never updated in place — a new rate
 * is a new row, so past reservations stay reproducible.
 */
@Entity('fx_rates')
@Index('uq_fx_rates_pair_as_of', ['baseCurrency', 'quoteCurrency', 'asOf'], { unique: true })
@Index('idx_fx_rates_pair_lookup', ['baseCurrency', 'quoteCurrency', 'asOf'])
export class FxRateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'base_currency', type: 'char', length: 3 })
  baseCurrency: string;

  @Column({ name: 'quote_currency', type: 'char', length: 3 })
  quoteCurrency: string;

  @Column({ type: 'numeric', precision: 24, scale: 12 })
  rate: string;

  /** When the rate became effective. */
  @Column({ name: 'as_of', type: 'timestamptz' })
  asOf: Date;

  /** Origin of the rate, e.g. SEED or TREASURY. */
  @Column({ type: 'varchar', length: 64 })
  source: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
