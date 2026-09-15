import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum OutboxMessageStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED',
  /** Out of retries; needs an operator. */
  Failed = 'FAILED',
}

/**
 * Transactional outbox row.
 *
 * PostgreSQL and Kafka cannot share a transaction, so publishing inline leaves
 * a window where capacity changed but the event was lost, or the reverse. The
 * event is written here in the same transaction and a background publisher
 * moves it to Kafka: at-least-once, with consumers deduplicating on `event_id`.
 */
@Entity('outbox_messages')
@Index('idx_outbox_pending', ['status', 'createdAt'], { where: `status = 'PENDING'` })
export class OutboxMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Id carried in the message so consumers can deduplicate. */
  @Index('uq_outbox_event_id', { unique: true })
  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ type: 'varchar', length: 200 })
  topic: string;

  /** Partition key: the program id, so one program's events stay ordered. */
  @Column({ name: 'message_key', type: 'varchar', length: 200 })
  messageKey: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  headers: Record<string, string>;

  @Column({ type: 'varchar', length: 16, default: OutboxMessageStatus.Pending })
  status: OutboxMessageStatus;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
