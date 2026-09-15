import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { outboxConfig } from '../config/configuration';
import { KafkaClientService } from '../kafka/kafka-client.service';
import { OutboxMessageEntity, OutboxMessageStatus } from './outbox-message.entity';

/**
 * Moves committed outbox rows to Kafka.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several instances can poll
 * the same table without publishing the same event twice.
 */
@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly kafka: KafkaClientService,
    @Inject(outboxConfig.KEY) private readonly config: ConfigType<typeof outboxConfig>,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled || !this.kafka.enabled) {
      this.logger.warn('Outbox publisher is disabled; events will accumulate in the table');
      return;
    }

    this.timer = setInterval(() => void this.drain(), this.config.pollIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Publishes one batch. Returns how many messages went out. */
  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      return await this.dataSource.transaction(async (manager) => {
        const batch = await manager
          .createQueryBuilder(OutboxMessageEntity, 'outbox')
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .where('outbox.status = :status', { status: OutboxMessageStatus.Pending })
          .orderBy('outbox.created_at', 'ASC')
          .limit(this.config.batchSize)
          .getMany();

        let published = 0;

        for (const message of batch) {
          try {
            await this.kafka.publish(message.topic, [
              {
                key: message.messageKey,
                value: JSON.stringify({ eventId: message.eventId, ...message.payload }),
                headers: { ...message.headers, 'x-event-type': message.eventType },
              },
            ]);

            message.status = OutboxMessageStatus.Published;
            message.publishedAt = new Date();
            published += 1;
          } catch (error) {
            message.attempts += 1;
            message.lastError = error instanceof Error ? error.message : String(error);

            if (message.attempts >= this.config.maxAttempts) {
              message.status = OutboxMessageStatus.Failed;
              this.logger.error(
                { eventId: message.eventId, topic: message.topic },
                `Giving up after ${message.attempts} attempts`,
              );
            }
          }

          await manager.save(OutboxMessageEntity, message);
        }

        return published;
      });
    } catch (error) {
      this.logger.error({ err: error }, 'Outbox drain failed');
      return 0;
    } finally {
      this.running = false;
    }
  }
}
