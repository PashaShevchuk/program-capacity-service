import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ConcurrentModificationError, ProgramNotFoundError } from '../common/errors/domain.errors';
import { ProgramEntity } from './program.entity';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CapacityChange {
  /** Signed change to the reserved total, in the program's minor units. */
  reservedDelta: bigint;
  /** Signed change to the credit limit. */
  limitDelta?: bigint;
  /** Set when a treasury message advanced the program's sequence. */
  treasurySequence?: bigint;
  reconciledAt?: Date;
}

/**
 * All reads and writes of a program's capacity go through here, so the locking
 * rules live in one place instead of being repeated at each call site.
 */
@Injectable()
export class ProgramCapacityRepository {
  /**
   * Loads a program and locks its row until the transaction ends.
   *
   * This is what stops two concurrent approvals from both seeing the same
   * availability and both succeeding. Locking serialises writes per program,
   * which is the right granularity: programs are independent, and a single
   * program's approvals are not a high-frequency path.
   */
  async lockProgram(manager: EntityManager, reference: string): Promise<ProgramEntity> {
    const program = await manager
      .createQueryBuilder(ProgramEntity, 'program')
      .setLock('pessimistic_write')
      .where(
        UUID_PATTERN.test(reference) ? 'program.id = :reference' : 'program.code = :reference',
        {
          reference,
        },
      )
      .getOne();

    if (!program) {
      throw new ProgramNotFoundError(reference);
    }

    return program;
  }

  async findProgram(manager: EntityManager, reference: string): Promise<ProgramEntity> {
    const program = await manager.findOne(ProgramEntity, {
      where: UUID_PATTERN.test(reference) ? { id: reference } : { code: reference },
    });

    if (!program) {
      throw new ProgramNotFoundError(reference);
    }

    return program;
  }

  /**
   * Records how far treasury's stream has been consumed.
   * Touches only bookkeeping columns, so it does not bump `version` and needs
   * no ledger entry to explain it.
   */
  async markTreasuryProgress(
    manager: EntityManager,
    program: ProgramEntity,
    sequence: bigint,
    reconciledAt?: Date,
  ): Promise<void> {
    await manager.update(
      ProgramEntity,
      { id: program.id },
      {
        lastTreasurySequence: sequence,
        ...(reconciledAt ? { lastReconciledAt: reconciledAt } : {}),
      },
    );

    program.lastTreasurySequence = sequence;
    if (reconciledAt) program.lastReconciledAt = reconciledAt;
  }

  /**
   * Applies a capacity change to a locked program row.
   *
   * The WHERE clause repeats the invariants the caller already checked. With
   * the row lock held they cannot fail, but if a future caller forgets to lock,
   * the update writes nothing rather than corrupting the balance, and the
   * affected-row check turns that into a loud error.
   */
  async applyChange(
    manager: EntityManager,
    program: ProgramEntity,
    change: CapacityChange,
  ): Promise<ProgramEntity> {
    const newReserved = program.reservedMinor + change.reservedDelta;
    const newLimit = program.totalLimitMinor + (change.limitDelta ?? 0n);

    const result = await manager
      .createQueryBuilder()
      .update(ProgramEntity)
      .set({
        reservedMinor: newReserved,
        totalLimitMinor: newLimit,
        version: () => '"version" + 1',
        ...(change.treasurySequence !== undefined
          ? { lastTreasurySequence: change.treasurySequence }
          : {}),
        ...(change.reconciledAt !== undefined ? { lastReconciledAt: change.reconciledAt } : {}),
      })
      .where('id = :id AND version = :version AND reserved_minor = :reserved', {
        id: program.id,
        version: program.version,
        reserved: program.reservedMinor.toString(),
      })
      .execute();

    if (result.affected !== 1) {
      throw new ConcurrentModificationError('Program', program.id);
    }

    program.reservedMinor = newReserved;
    program.totalLimitMinor = newLimit;
    program.version += 1;
    if (change.treasurySequence !== undefined)
      program.lastTreasurySequence = change.treasurySequence;
    if (change.reconciledAt !== undefined) program.lastReconciledAt = change.reconciledAt;

    return program;
  }
}
