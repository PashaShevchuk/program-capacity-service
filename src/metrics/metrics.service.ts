import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
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
    help: 'Reserved divided by total limit; above 1 when treasury reports an overcommit',
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

  /** Called after a capacity change commits, so the gauges track real state. */
  recordCapacity(program: {
    code: string;
    currency: string;
    available: { minorUnits: bigint };
    reservedMinor: bigint;
    totalLimitMinor: bigint;
  }): void {
    this.availableCapacity.set(
      { program: program.code, currency: program.currency },
      Number(program.available.minorUnits),
    );

    const utilisation =
      program.totalLimitMinor === 0n
        ? 0
        : new Decimal(program.reservedMinor.toString())
            .dividedBy(new Decimal(program.totalLimitMinor.toString()))
            .toNumber();

    this.utilisation.set({ program: program.code }, utilisation);
  }

  recordReservationOutcome(
    programCode: string,
    outcome: 'accepted' | 'rejected' | 'replayed',
  ): void {
    this.reservations.inc({ program: programCode, outcome });
  }
}
