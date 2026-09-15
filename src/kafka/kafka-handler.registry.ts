import { Injectable, Logger } from '@nestjs/common';

import { type KafkaMessageHandler } from './kafka-message';

/**
 * Maps topics to handlers. Handlers register themselves on module init, which
 * keeps the consumer from having to import every feature module that owns one.
 */
@Injectable()
export class KafkaHandlerRegistry {
  private readonly logger = new Logger(KafkaHandlerRegistry.name);
  private readonly handlers = new Map<string, KafkaMessageHandler>();

  register(handler: KafkaMessageHandler): void {
    if (this.handlers.has(handler.topic)) {
      throw new Error(`Two handlers registered for topic ${handler.topic}`);
    }

    this.handlers.set(handler.topic, handler);
    this.logger.log(`Registered handler for ${handler.topic}`);
  }

  get(topic: string): KafkaMessageHandler | undefined {
    return this.handlers.get(topic);
  }

  topics(): string[] {
    return [...this.handlers.keys()];
  }
}
