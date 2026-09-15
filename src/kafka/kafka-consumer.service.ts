import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { type Consumer, type EachMessagePayload } from 'kafkajs';
import { DataSource } from 'typeorm';
import { setTimeout as delay } from 'node:timers/promises';

import { DomainError } from '../common/errors/domain.errors';
import { kafkaConfig } from '../config/configuration';
import { isUniqueViolation } from '../database/postgres-errors';
import { MetricsService } from '../metrics/metrics.service';
import { KafkaClientService } from './kafka-client.service';
import { KafkaHandlerRegistry } from './kafka-handler.registry';
import { type AfterCommit, type ParsedKafkaMessage } from './kafka-message';
import { ProcessedMessageEntity } from './processed-message.entity';

@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private consumer?: Consumer;
  private stopping = false;

  constructor(
    private readonly client: KafkaClientService,
    private readonly registry: KafkaHandlerRegistry,
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    @Inject(kafkaConfig.KEY) private readonly config: ConfigType<typeof kafkaConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const topics = this.registry.topics();

    if (!this.client.enabled || topics.length === 0) {
      return;
    }

    this.consumer = this.client.kafka.consumer({
      groupId: this.config.consumerGroupId,
      sessionTimeout: 30_000,
    });

    await this.consumer.connect();
    for (const topic of topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    // Offsets are committed by hand after a message is applied or parked in the
    // DLQ, so a crash mid-processing replays the message rather than losing it.
    await this.consumer.run({
      autoCommit: false,
      eachMessage: (payload) => this.onMessage(payload),
    });

    this.logger.log(`Consuming ${topics.join(', ')} as group ${this.config.consumerGroupId}`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.consumer?.disconnect();
  }

  private async onMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const stopTimer = this.metrics.kafkaProcessingSeconds.startTimer({ topic });

    let parsed: ParsedKafkaMessage;
    try {
      parsed = parseMessage(payload);
    } catch (error) {
      this.logger.error({ err: error, topic, offset: message.offset }, 'Message is not valid JSON');
      await this.sendToDlq(payload, error);
      await this.commit(topic, partition, message.offset);
      this.metrics.kafkaMessages.inc({ topic, outcome: 'dlq' });
      stopTimer();
      return;
    }

    const outcome = await this.processWithRetries(parsed, payload);

    await this.commit(topic, partition, message.offset);
    this.metrics.kafkaMessages.inc({ topic, outcome });
    stopTimer();
  }

  private async processWithRetries(
    parsed: ParsedKafkaMessage,
    payload: EachMessagePayload,
  ): Promise<'applied' | 'duplicate' | 'dlq'> {
    for (let attempt = 1; attempt <= this.config.maxProcessingAttempts; attempt += 1) {
      try {
        return (await this.processMessage(parsed)) ? 'applied' : 'duplicate';
      } catch (error) {
        // A business or validation error will fail the same way every time,
        // so retrying only delays the inevitable.
        const permanent = error instanceof DomainError;
        const lastAttempt = attempt === this.config.maxProcessingAttempts;

        this.logger.error(
          { err: error, topic: parsed.topic, eventId: parsed.eventId, attempt, permanent },
          'Failed to process message',
        );

        if (permanent || lastAttempt || this.stopping) {
          await this.sendToDlq(payload, error);
          return 'dlq';
        }

        await delay(this.config.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    return 'dlq';
  }

  /**
   * Applies one parsed message: deduplicate, run the handler and record the
   * message, all in one transaction. Returns false when it was already applied.
   *
   * Public so the message pipeline can be exercised in tests without a broker.
   */
  async processMessage(parsed: ParsedKafkaMessage): Promise<boolean> {
    const handler = this.registry.get(parsed.topic);

    if (!handler) {
      this.logger.warn(`No handler for topic ${parsed.topic}; ignoring message`);
      return false;
    }

    try {
      const afterCommit = await this.dataSource.transaction(async (manager) => {
        // Claim the message first: if this insert conflicts, the work below has
        // already been done by an earlier delivery and the transaction unwinds.
        await manager.insert(ProcessedMessageEntity, {
          messageKey: `${parsed.topic}:${parsed.eventId}`,
          topic: parsed.topic,
          partition: parsed.partition,
          kafkaOffset: parsed.offset,
          eventType: parsed.eventType,
          processedAt: new Date(),
        });

        return (await handler.handle(parsed, manager)) as AfterCommit | undefined;
      });

      afterCommit?.();

      return true;
    } catch (error) {
      if (isUniqueViolation(error, 'uq_processed_messages_key')) {
        this.logger.debug(`Skipping duplicate ${parsed.topic}:${parsed.eventId}`);
        return false;
      }
      throw error;
    }
  }

  private async sendToDlq(payload: EachMessagePayload, error: unknown): Promise<void> {
    const dlqTopic = `${payload.topic}${this.config.dlqSuffix}`;

    try {
      await this.client.publish(dlqTopic, [
        {
          key: payload.message.key,
          value: payload.message.value,
          headers: {
            ...toStringHeaders(payload.message.headers),
            'x-error': error instanceof Error ? error.message : String(error),
            'x-original-topic': payload.topic,
            'x-original-partition': String(payload.partition),
            'x-original-offset': payload.message.offset,
            'x-failed-at': new Date().toISOString(),
          },
        },
      ]);

      this.logger.warn(`Message parked in ${dlqTopic}`);
    } catch (dlqError) {
      // Losing the DLQ write would lose the message entirely, so it is loud.
      this.logger.error({ err: dlqError, dlqTopic }, 'Could not write to the DLQ');
    }
  }

  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer?.commitOffsets([
      { topic, partition, offset: (BigInt(offset) + 1n).toString() },
    ]);
  }
}

function parseMessage(payload: EachMessagePayload): ParsedKafkaMessage {
  const raw = payload.message.value?.toString('utf8');

  if (!raw) {
    throw new Error('Message has an empty body');
  }

  const body = JSON.parse(raw) as Record<string, unknown>;
  const eventId = typeof body.eventId === 'string' ? body.eventId : null;

  if (!eventId) {
    throw new Error('Message has no eventId, so it cannot be deduplicated');
  }

  return {
    topic: payload.topic,
    partition: payload.partition,
    offset: payload.message.offset,
    key: payload.message.key?.toString('utf8') ?? null,
    headers: toStringHeaders(payload.message.headers),
    body,
    eventId,
    eventType: typeof body.eventType === 'string' ? body.eventType : null,
    timestamp: new Date(Number(payload.message.timestamp)),
  };
}

function toStringHeaders(
  headers: EachMessagePayload['message']['headers'],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [key, value?.toString('utf8') ?? '']),
  );
}
