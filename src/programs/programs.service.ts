import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';

import {
  CurrencyMismatchError,
  ProgramCodeTakenError,
  ProgramLimitBelowReservedError,
} from '../common/errors/domain.errors';
import { type Money } from '../common/money/money';
import {
  buildCursorPage,
  type CursorPageDto,
  type CursorQueryDto,
} from '../common/pagination/cursor-pagination.dto';
import { applyKeyset } from '../common/pagination/keyset';
import { PageDto, type PaginationQueryDto } from '../common/pagination/pagination.dto';
import { kafkaConfig } from '../config/configuration';
import { isUniqueViolation } from '../database/postgres-errors';
import {
  CapacityLedgerEntryEntity,
  LedgerEntrySource,
  LedgerEntryType,
} from '../ledger/capacity-ledger-entry.entity';
import { type LedgerActor } from '../ledger/ledger-actor';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { CAPACITY_CHANGED_EVENT_TYPE, buildCapacityChangedPayload } from './capacity-changed.event';
import { CapacityEventsService } from './capacity-events.service';
import { ProgramCapacityRepository } from './program-capacity.repository';
import { ProgramEntity } from './program.entity';

export interface CreateProgramCommand {
  code: string;
  name: string;
  totalLimit: Money;
  actor: LedgerActor;
  correlationId?: string | null;
}

export interface ChangeLimitCommand {
  programRef: string;
  totalLimit: Money;
  actor: LedgerActor;
  correlationId?: string | null;
  reason?: string | null;
}

@Injectable()
export class ProgramsService {
  private readonly logger = new Logger(ProgramsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly capacity: ProgramCapacityRepository,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly capacityEvents: CapacityEventsService,
    @Inject(kafkaConfig.KEY) private readonly kafka: ConfigType<typeof kafkaConfig>,
  ) {}

  async list(query: PaginationQueryDto): Promise<PageDto<ProgramEntity>> {
    const [items, total] = await this.dataSource.manager.findAndCount(ProgramEntity, {
      order: { code: 'ASC' },
      skip: query.skip,
      take: query.pageSize,
    });

    return PageDto.of(items, total, query);
  }

  findOne(reference: string): Promise<ProgramEntity> {
    return this.capacity.findProgram(this.dataSource.manager, reference);
  }

  /**
   * The audit trail, newest first. Cursor-paged: the ledger is append-only, so
   * offsets would shift under a client that reads while the service writes.
   */
  async ledgerEntries(
    reference: string,
    query: CursorQueryDto,
  ): Promise<CursorPageDto<CapacityLedgerEntryEntity>> {
    const program = await this.findOne(reference);

    const rows = await applyKeyset(
      this.dataSource.manager
        .createQueryBuilder(CapacityLedgerEntryEntity, 'entry')
        .where('entry.program_id = :programId', { programId: program.id }),
      { alias: 'entry', timestampColumn: 'created_at', limit: query.limit, cursor: query.cursor },
    ).getMany();

    return buildCursorPage(rows, query.limit, (entry) => entry.createdAt);
  }

  /** Creates a program and opens its ledger with the initial limit. */
  async create(command: CreateProgramCommand): Promise<ProgramEntity> {
    try {
      const program = await this.dataSource.transaction(async (manager) => {
        const saved = await manager.save(
          ProgramEntity,
          manager.create(ProgramEntity, {
            code: command.code,
            name: command.name,
            currency: command.totalLimit.currency,
            totalLimitMinor: command.totalLimit.minorUnits,
            reservedMinor: 0n,
          }),
        );

        await this.ledger.append(manager, {
          program: saved,
          entryType: LedgerEntryType.LimitChange,
          source: LedgerEntrySource.Api,
          actor: command.actor,
          reservedDelta: 0n,
          limitDelta: command.totalLimit.minorUnits,
          correlationId: command.correlationId,
          reason: `Program created with a ${command.totalLimit.toString()} limit`,
        });

        return saved;
      });

      this.logger.log(
        `Created program ${program.code} with limit ${command.totalLimit.toString()}`,
      );

      return program;
    } catch (error) {
      if (isUniqueViolation(error, 'uq_programs_code')) {
        throw new ProgramCodeTakenError(command.code);
      }
      throw error;
    }
  }

  /**
   * Changes the credit limit.
   *
   * Lowering below what is already reserved is refused: the alternative is a
   * program that reports negative availability with no way to explain it, and
   * the caller should release reservations first.
   */
  async changeLimit(command: ChangeLimitCommand): Promise<ProgramEntity> {
    const program = await this.dataSource.transaction(async (manager) => {
      const locked = await this.capacity.lockProgram(manager, command.programRef);

      if (command.totalLimit.currency !== locked.currency) {
        throw new CurrencyMismatchError(locked.currency, command.totalLimit.currency);
      }

      if (command.totalLimit.isLessThan(locked.reserved)) {
        throw new ProgramLimitBelowReservedError({
          programId: locked.code,
          newLimit: command.totalLimit.toDecimalString(),
          reserved: locked.reserved.toDecimalString(),
        });
      }

      const delta = command.totalLimit.minorUnits - locked.totalLimitMinor;
      if (delta === 0n) {
        return locked;
      }

      await this.capacity.applyChange(manager, locked, { reservedDelta: 0n, limitDelta: delta });

      await this.ledger.append(manager, {
        program: locked,
        entryType: LedgerEntryType.LimitChange,
        source: LedgerEntrySource.Api,
        actor: command.actor,
        reservedDelta: 0n,
        limitDelta: delta,
        correlationId: command.correlationId,
        reason: command.reason ?? 'Credit limit changed through the API',
      });

      await this.outbox.enqueue(manager, {
        topic: this.kafka.topics.capacityChanged,
        messageKey: locked.id,
        eventType: CAPACITY_CHANGED_EVENT_TYPE,
        payload: buildCapacityChangedPayload(locked, 'LIMIT_CHANGE'),
      });

      return locked;
    });

    this.capacityEvents.publish(buildCapacityChangedPayload(program, 'LIMIT_CHANGE'));

    return program;
  }
}
