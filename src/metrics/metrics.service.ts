import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/**
 * Metrics that answer operational questions this service will actually be
 * asked: how close is a program to its limit, and is Kafka processing healthy.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly reservations = new Counter({
    name: 'capacity_reservations_total',
    help: 'Reservation outcomes',
    labelNames: ['program', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly availableCapacity = new Gauge({
    name: 'capacity_available_minor_units',
    help: 'Capacity still available, in the program currency minor units',
    labelNames: ['program', 'currency'] as const,
    registers: [this.registry],
  });

  readonly utilisation = new Gauge({
    name: 'capacity_utilisation_ratio',
    help: 'Reserved divided by total limit, between 0 and 1',
    labelNames: ['program'] as const,
    registers: [this.registry],
  });

  readonly kafkaMessages = new Counter({
    name: 'kafka_messages_total',
    help: 'Kafka messages by topic and outcome',
    labelNames: ['topic', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly kafkaProcessingSeconds = new Histogram({
    name: 'kafka_message_processing_seconds',
    help: 'Time to process one Kafka message',
    labelNames: ['topic'] as const,
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
