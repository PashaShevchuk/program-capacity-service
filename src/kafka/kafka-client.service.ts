import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { Kafka, type Message, type Producer, logLevel } from 'kafkajs';

import { kafkaConfig } from '../config/configuration';
import { registerCompressionCodecs } from './compression';

/**
 * Owns the Kafka connection and the shared producer.
 *
 * When `KAFKA_ENABLED=false` the service still starts and serves HTTP, so the
 * API can be run and tested without a broker.
 */
@Injectable()
export class KafkaClientService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaClientService.name);
  private producer?: Producer;

  readonly kafka: Kafka;

  constructor(@Inject(kafkaConfig.KEY) private readonly config: ConfigType<typeof kafkaConfig>) {
    registerCompressionCodecs();

    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      logLevel: logLevel.WARN,
      retry: { initialRetryTime: 300, retries: 8 },
    });
  }

  get enabled(): boolean {
    return this.config.enabled && this.config.brokers.length > 0;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Kafka is disabled; treasury messages will not be consumed or published');
      return;
    }

    this.producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await this.producer.connect();
    this.logger.log(`Producer connected to ${this.config.brokers.join(', ')}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.producer?.disconnect();
  }

  async publish(topic: string, messages: Message[]): Promise<void> {
    if (!this.producer) {
      throw new Error('Kafka producer is not connected');
    }

    await this.producer.send({ topic, messages });
  }
}
