import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { type ProgramEntity } from '../programs/program.entity';
import {
  CapacityLedgerEntryEntity,
  type LedgerEntrySource,
  type LedgerEntryType,
} from './capacity-ledger-entry.entity';
import { type LedgerActor } from './ledger-actor';

export interface AppendLedgerEntry {
  /** The program as it stands *after* the change was applied. */
  program: ProgramEntity;
  entryType: LedgerEntryType;
  source: LedgerEntrySource;
  /** Who caused the movement. */
  actor: LedgerActor;
  reservedDelta: bigint;
  limitDelta?: bigint;
  reservationId?: string | null;
  reason?: string | null;
  correlationId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class LedgerService {
  /** Must be called with the same manager, and after the program row is updated. */
  append(manager: EntityManager, entry: AppendLedgerEntry): Promise<CapacityLedgerEntryEntity> {
    const row = manager.create(CapacityLedgerEntryEntity, {
      programId: entry.program.id,
      reservationId: entry.reservationId ?? null,
      entryType: entry.entryType,
      source: entry.source,
      currency: entry.program.currency,
      reservedDeltaMinor: entry.reservedDelta,
      limitDeltaMinor: entry.limitDelta ?? 0n,
      reservedAfterMinor: entry.program.reservedMinor,
      limitAfterMinor: entry.program.totalLimitMinor,
      reason: entry.reason ?? null,
      actorType: entry.actor.type,
      actorId: entry.actor.id,
      actorLabel: entry.actor.label,
      correlationId: entry.correlationId ?? null,
      occurredAt: entry.occurredAt ?? new Date(),
      metadata: entry.metadata ?? {},
    });

    return manager.save(CapacityLedgerEntryEntity, row);
  }
}
