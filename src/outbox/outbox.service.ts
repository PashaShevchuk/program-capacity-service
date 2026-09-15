import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { OutboxMessageEntity } from './outbox-message.entity';

export interface EnqueueMessage {
  topic: string;
  /** Partition key. Use the program id so one program's events stay ordered. */
  messageKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}

@Injectable()
export class OutboxService {
  /** Writes the event in the caller's transaction; the publisher sends it later. */
  async enqueue(manager: EntityManager, message: EnqueueMessage): Promise<string> {
    const eventId = randomUUID();

    const row = manager.create(OutboxMessageEntity, {
      eventId,
      topic: message.topic,
      messageKey: message.messageKey,
      eventType: message.eventType,
      payload: message.payload,
      headers: message.headers ?? {},
    });

    await manager.save(OutboxMessageEntity, row);

    return eventId;
  }
}
