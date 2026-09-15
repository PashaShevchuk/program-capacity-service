import { randomUUID } from 'node:crypto';
import { config as loadDotEnv } from 'dotenv';
import { Kafka } from 'kafkajs';

loadDotEnv({ quiet: true });

/**
 * Publishes a short run of treasury messages so the Kafka side can be tried
 * without a real treasury system.
 *
 *   npm run simulate:treasury -- PRG-USD-001
 *
 * Watch the effect with:
 *   GET /v1/programs/PRG-USD-001/capacity
 *   GET /v1/programs/PRG-USD-001/ledger
 */
const programCode = process.argv[2] ?? 'PRG-USD-001';

const kafka = new Kafka({
  clientId: 'treasury-simulator',
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(','),
});

const EVENTS = process.env.KAFKA_TOPIC_TREASURY_EVENTS ?? 'treasury.capacity.events.v1';
const RECONCILIATION =
  process.env.KAFKA_TOPIC_TREASURY_RECONCILIATION ?? 'treasury.capacity.reconciliation.v1';

const log = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const producer = kafka.producer();
  await producer.connect();

  const send = async (topic: string, body: Record<string, unknown>): Promise<void> => {
    await producer.send({
      topic,
      messages: [{ key: programCode, value: JSON.stringify(body) }],
    });
  };

  const base = Date.now();
  const envelope = (offset: number) => ({
    eventId: randomUUID(),
    programCode,
    sequence: String(base + offset),
    occurredAt: new Date().toISOString(),
  });

  log('1. Full reconciliation snapshot: limit 12,000,000 and 2,000,000 reserved');
  const snapshot = {
    ...envelope(0),
    asOf: new Date().toISOString(),
    totalLimit: { amount: '12000000.00', currency: 'USD' },
    reservedTotal: { amount: '2000000.00', currency: 'USD' },
    openReservations: [
      { invoiceId: 'TR-A', amount: { amount: '1200000.00', currency: 'USD' } },
      { invoiceId: 'TR-B', amount: { amount: '800000.00', currency: 'USD' } },
    ],
  };
  await send(RECONCILIATION, snapshot);
  await wait(2000);

  log('2. The same message again: must be deduplicated, nothing changes');
  await send(RECONCILIATION, snapshot);
  await wait(2000);

  log('3. An older snapshot arriving late: must be ignored');
  await send(RECONCILIATION, {
    ...snapshot,
    eventId: randomUUID(),
    sequence: String(base - 1),
    totalLimit: { amount: '1.00', currency: 'USD' },
    reservedTotal: { amount: '0.00', currency: 'USD' },
  });
  await wait(2000);

  log('4. A reservation made in the treasury system, in EUR');
  await send(EVENTS, {
    ...envelope(1),
    eventType: 'CapacityReserved',
    payload: {
      invoiceId: `TR-${Date.now()}`,
      amount: { amount: '500000.00', currency: 'EUR' },
      externalReference: 'TRS-77',
    },
  });
  await wait(2000);

  log('5. A malformed message: must land in the DLQ without blocking the partition');
  await send(EVENTS, {
    ...envelope(2),
    eventType: 'CapacityReserved',
    payload: { invoiceId: '', amount: { amount: 'not-a-number', currency: 'XXX' } },
  });
  await wait(2000);

  log('6. A valid limit change after the bad message: must still be applied');
  await send(EVENTS, {
    ...envelope(3),
    eventType: 'ProgramLimitChanged',
    payload: { totalLimit: { amount: '15000000.00', currency: 'USD' } },
  });
  await wait(2000);

  await producer.disconnect();
  log('\nDone. Check the capacity and ledger endpoints, and the DLQ topic.');
}

main().catch((error: unknown) => {
  process.stderr.write(`simulation failed: ${String(error)}\n`);
  process.exit(1);
});
