import { type EachMessagePayload } from 'kafkajs';

import { MalformedMessageError } from '../common/errors/domain.errors';
import { KafkaConsumerService } from './kafka-consumer.service';

/**
 * A message that cannot be applied must end up somewhere. If the DLQ write
 * fails and the offset is committed anyway, the message is gone from both the
 * topic and the dead-letter queue, and a capacity movement is lost silently.
 */
describe('KafkaConsumerService dead-letter handling', () => {
  const payload = (body: unknown): EachMessagePayload =>
    ({
      topic: 'treasury.capacity.events.v1',
      partition: 0,
      message: {
        offset: '7',
        key: Buffer.from('PRG-1'),
        value: Buffer.from(JSON.stringify(body)),
        headers: {},
        timestamp: String(Date.now()),
        attributes: 0,
        size: 0,
      },
      heartbeat: () => Promise.resolve(),
      pause: () => () => undefined,
    }) as unknown as EachMessagePayload;

  const build = (publish: jest.Mock) => {
    const commit = jest.fn().mockResolvedValue(undefined);

    const consumer = new KafkaConsumerService(
      { enabled: true, publish, kafka: {} } as never,
      {
        get: () => ({ topic: 'treasury.capacity.events.v1', handle: () => Promise.resolve() }),
      } as never,
      {
        transaction: () => Promise.reject(new MalformedMessageError('t', ['broken'])),
      } as never,
      {
        kafkaMessages: { inc: jest.fn() },
        kafkaProcessingSeconds: { startTimer: () => () => 0 },
      } as never,
      {
        consumerGroupId: 'test',
        dlqSuffix: '.dlq',
        maxProcessingAttempts: 1,
        retryBaseDelayMs: 0,
      } as never,
    );

    // The consumer is created here rather than connected to a broker.
    (consumer as unknown as { consumer: { commitOffsets: jest.Mock } }).consumer = {
      commitOffsets: commit,
    };

    return { consumer, commit };
  };

  it('commits the offset once the message is parked', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const { consumer, commit } = build(publish);

    await consumer.onMessage(payload({ eventId: '11111111-1111-4111-8111-111111111111' }));

    expect(publish).toHaveBeenCalledWith('treasury.capacity.events.v1.dlq', expect.anything());
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('leaves the offset alone when the message could not be parked', async () => {
    const publish = jest.fn().mockRejectedValue(new Error('broker unavailable'));
    const { consumer, commit } = build(publish);

    await expect(
      consumer.onMessage(payload({ eventId: '11111111-1111-4111-8111-111111111111' })),
    ).rejects.toThrow('broker unavailable');

    // Not committed, so the broker redelivers instead of losing the message.
    expect(commit).not.toHaveBeenCalled();
  });
});
