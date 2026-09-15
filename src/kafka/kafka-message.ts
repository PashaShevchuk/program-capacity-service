import { type EntityManager } from 'typeorm';

/** A consumed message after its JSON body has been parsed. */
export interface ParsedKafkaMessage<T = unknown> {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  headers: Record<string, string>;
  body: T;
  /** I'd used for deduplication. Taken from the body's `eventId`. */
  eventId: string;
  eventType: string | null;
  timestamp: Date;
}

/** Side effects that must not run until the transaction has committed. */
export type AfterCommit = () => void;

/**
 * Handles messages from one topic.
 *
 * The consumer calls `handle` inside a transaction that also records the
 * message as processed, so a handler must do all of its writing through the
 * `manager` it is given. Throwing rolls the whole thing back and the message is
 * retried or sent to the DLQ. Anything that should only happen once the change
 * is durable, such as notifying subscribers, is returned as a callback.
 */
export interface KafkaMessageHandler {
  readonly topic: string;
  handle(message: ParsedKafkaMessage, manager: EntityManager): Promise<AfterCommit | void>;
}
