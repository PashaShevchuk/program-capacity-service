import { CompressionCodecs, CompressionTypes } from 'kafkajs';

/**
 * Teaches KafkaJS to read Snappy-compressed batches.
 *
 * KafkaJS only handles gzip out of the box, and a batch in any other codec does
 * not fail the message — it crashes the consumer, which then stops consuming
 * entirely while the service still reports healthy. Snappy is the default for
 * `rpk`, for Redpanda Console and for most producer configurations, so a real
 * treasury feed would very likely arrive this way.
 *
 * `snappyjs` is pure JavaScript, so this costs no native build step.
 */
export function registerCompressionCodecs(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const snappy = require('kafkajs-snappy') as () => unknown;

  CompressionCodecs[CompressionTypes.Snappy] = snappy;
}
