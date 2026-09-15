import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Deduplication record for consumed Kafka messages.
 *
 * Kafka delivers at least once, so a consumer that dies before committing its
 * offset sees the message again. Inserting this row in the same transaction as
 * the state change makes processing effectively exactly-once: the unique
 * constraint rejects the redelivery and the transaction rolls back.
 */
@Entity('processed_messages')
@Index('idx_processed_messages_processed_at', ['processedAt'])
export class ProcessedMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** `<topic>:<eventId>`, scoped by topic so a replay onto another topic still runs. */
  @Index('uq_processed_messages_key', { unique: true })
  @Column({ name: 'message_key', type: 'varchar', length: 300 })
  messageKey: string;

  @Column({ type: 'varchar', length: 200 })
  topic: string;

  @Column({ type: 'integer' })
  partition: number;

  @Column({ name: 'kafka_offset', type: 'varchar', length: 32 })
  kafkaOffset: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100, nullable: true })
  eventType: string | null;

  @Column({ name: 'processed_at', type: 'timestamptz' })
  processedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
