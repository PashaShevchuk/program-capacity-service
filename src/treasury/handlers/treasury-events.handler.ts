import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { EntityManager } from 'typeorm';

import { CurrencyMismatchError } from '../../common/errors/domain.errors';
import { MoneyDto } from '../../common/money/money.dto';
import { kafkaConfig } from '../../config/configuration';
import { KafkaHandlerRegistry } from '../../kafka/kafka-handler.registry';
import {
  type AfterCommit,
  type KafkaMessageHandler,
  type ParsedKafkaMessage,
} from '../../kafka/kafka-message';
import { LedgerEntrySource, LedgerEntryType } from '../../ledger/capacity-ledger-entry.entity';
import { TREASURY_ACTOR } from '../../ledger/ledger-actor';
import { LedgerService } from '../../ledger/ledger.service';
import { MetricsService } from '../../metrics/metrics.service';
import { OutboxService } from '../../outbox/outbox.service';
import {
  CAPACITY_CHANGED_EVENT_TYPE,
  buildCapacityChangedPayload,
} from '../../programs/capacity-changed.event';
import { CapacityEventsService } from '../../programs/capacity-events.service';
import { ProgramCapacityRepository } from '../../programs/program-capacity.repository';
import { type ProgramEntity } from '../../programs/program.entity';
import {
  ReservationSource,
  ReservationStatus,
} from '../../reservations/invoice-reservation.entity';
import { ReservationsService } from '../../reservations/reservations.service';
import {
  CapacityReleasedPayloadDto,
  CapacityReservedPayloadDto,
  ProgramLimitChangedPayloadDto,
  TreasuryEventDto,
  TreasuryEventType,
} from '../dto/treasury-messages.dto';
import { isStaleSequence } from '../reconciliation.calculator';
import { parseMessageBody } from '../message-validation';

/**
 * Applies incremental capacity events from the treasury system: reservations
 * and releases made outside this service, and limit changes.
 */
@Injectable()
export class TreasuryEventsHandler implements KafkaMessageHandler, OnModuleInit {
  private readonly logger = new Logger(TreasuryEventsHandler.name);

  readonly topic: string;

  constructor(
    private readonly registry: KafkaHandlerRegistry,
    private readonly reservations: ReservationsService,
    private readonly programs: ProgramCapacityRepository,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly capacityEvents: CapacityEventsService,
    private readonly metrics: MetricsService,
    @Inject(kafkaConfig.KEY) private readonly config: ConfigType<typeof kafkaConfig>,
  ) {
    this.topic = config.topics.treasuryEvents;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(message: ParsedKafkaMessage, manager: EntityManager): Promise<AfterCommit | void> {
    const event = parseMessageBody(this.topic, TreasuryEventDto, message.body);
    const program = await this.programs.lockProgram(manager, event.programCode);
    const sequence = BigInt(event.sequence);

    if (isStaleSequence(program.lastTreasurySequence, sequence)) {
      this.logger.warn(
        `Ignoring ${event.eventType} for ${event.programCode}: sequence ${sequence} is not newer than ${program.lastTreasurySequence}`,
      );
      return;
    }

    const occurredAt = new Date(event.occurredAt);
    const afterCommit = await this.applyEvent(manager, program, event, occurredAt, message.eventId);

    await this.programs.markTreasuryProgress(manager, program, sequence);

    return afterCommit;
  }

  private async applyEvent(
    manager: EntityManager,
    program: ProgramEntity,
    event: TreasuryEventDto,
    occurredAt: Date,
    correlationId: string,
  ): Promise<AfterCommit | void> {
    switch (event.eventType) {
      case TreasuryEventType.CapacityReserved: {
        const payload = parseMessageBody(this.topic, CapacityReservedPayloadDto, event.payload);

        const result = await this.reservations.reserveWithin(manager, {
          programRef: program.id,
          invoiceId: payload.invoiceId,
          amount: MoneyDto.toMoney(payload.amount),
          source: ReservationSource.Treasury,
          ledgerSource: LedgerEntrySource.TreasuryEvent,
          actor: TREASURY_ACTOR,
          allowOvercommit: true,
          externalReference: payload.externalReference ?? null,
          correlationId,
          occurredAt,
        });

        return () => this.reservations.announce(result, 'RESERVE');
      }

      case TreasuryEventType.CapacityReleased: {
        const payload = parseMessageBody(this.topic, CapacityReleasedPayloadDto, event.payload);

        const result = await this.reservations.closeWithin(
          manager,
          {
            programRef: program.id,
            reservationRef: payload.invoiceId,
            ledgerSource: LedgerEntrySource.TreasuryEvent,
            actor: TREASURY_ACTOR,
            allowAlreadyClosed: true,
            correlationId,
            occurredAt,
            reason: payload.reason ?? 'Released by the treasury system',
          },
          ReservationStatus.Released,
        );

        return () => this.reservations.announce(result, 'RELEASE');
      }

      case TreasuryEventType.ProgramLimitChanged: {
        const payload = parseMessageBody(this.topic, ProgramLimitChangedPayloadDto, event.payload);
        const newLimit = MoneyDto.toMoney(payload.totalLimit);

        if (newLimit.currency !== program.currency) {
          throw new CurrencyMismatchError(program.currency, newLimit.currency);
        }

        const delta = newLimit.minorUnits - program.totalLimitMinor;
        if (delta === 0n) return;

        await this.programs.applyChange(manager, program, { reservedDelta: 0n, limitDelta: delta });

        await this.ledger.append(manager, {
          program,
          entryType: LedgerEntryType.LimitChange,
          source: LedgerEntrySource.TreasuryEvent,
          actor: TREASURY_ACTOR,
          reservedDelta: 0n,
          limitDelta: delta,
          correlationId,
          occurredAt,
          reason: `Treasury set the limit to ${newLimit.toString()}`,
        });

        // Reserve and release reach subscribers through ReservationsService.
        // A limit change has no such path of its own, so it publishes here or
        // every consumer keeps the old limit.
        const changed = buildCapacityChangedPayload(program, 'LIMIT_CHANGE');

        await this.outbox.enqueue(manager, {
          topic: this.config.topics.capacityChanged,
          messageKey: program.id,
          eventType: CAPACITY_CHANGED_EVENT_TYPE,
          payload: changed,
        });

        return () => {
          this.metrics.recordCapacity(program);
          this.capacityEvents.publish(changed);
        };
      }
    }
  }
}
