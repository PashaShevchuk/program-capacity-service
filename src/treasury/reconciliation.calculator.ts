/**
 * Works out what a program's reserved total should be after a treasury snapshot.
 *
 * The snapshot is right as at `asOf`, but we have moved on since: reservations
 * treasury has not seen yet, and ones it still counts that we have closed.
 *
 *   expected = max(snapshot + opened after asOf - closed after asOf, open rows)
 *
 * Pure, so the arithmetic is testable without a database.
 */
export interface ReconciliationInput {
  /** Reserved total reported by treasury, as at `asOf`. */
  snapshotReservedMinor: bigint;
  /** Credit limit reported by treasury. */
  snapshotLimitMinor: bigint;
  /** What this service currently holds. */
  currentReservedMinor: bigint;
  currentLimitMinor: bigint;
  /** Opened here after `asOf` and still open, so absent from the snapshot. */
  openedLocallyAfterSnapshotMinor: bigint;
  /** Counted by the snapshot but closed here after `asOf`. */
  closedLocallyAfterSnapshotMinor: bigint;
  /** Everything still open locally, after the rows have been reconciled. */
  openReservationsMinor: bigint;
}

export interface ReconciliationOutcome {
  expectedReservedMinor: bigint;
  /** Applied to the program to bring it in line. */
  reservedAdjustmentMinor: bigint;
  limitAdjustmentMinor: bigint;
  hasDrift: boolean;
  hasLimitChange: boolean;
  /**
   * True when the snapshot arithmetic came out below what the open rows hold
   * and the floor had to raise it. Treasury and this service disagree about
   * what is outstanding, and an operator should look.
   */
  flooredToOpenRows: boolean;
}

export function reconcileCapacity(input: ReconciliationInput): ReconciliationOutcome {
  const expectedRaw =
    input.snapshotReservedMinor +
    input.openedLocallyAfterSnapshotMinor -
    input.closedLocallyAfterSnapshotMinor;

  /*
   * The reserved total may never fall below what the open reservations add up
   * to. `asOf` is treasury's clock, and it cannot say whether treasury has
   * *received* a reservation this service accepted just before it — so a
   * reservation made at 10:00:00 and a snapshot taken at 10:00:01 that has not
   * seen it yet would otherwise wipe it from the balance while its row stayed
   * open, and the freed capacity could be handed out a second time.
   *
   * Holding the floor can leave the program temporarily over-reserved, which
   * costs availability. Dropping below it costs money.
   */
  const floor = input.openReservationsMinor > 0n ? input.openReservationsMinor : 0n;
  const expectedReservedMinor = expectedRaw > floor ? expectedRaw : floor;

  const reservedAdjustmentMinor = expectedReservedMinor - input.currentReservedMinor;
  const limitAdjustmentMinor = input.snapshotLimitMinor - input.currentLimitMinor;

  return {
    expectedReservedMinor,
    reservedAdjustmentMinor,
    limitAdjustmentMinor,
    hasDrift: reservedAdjustmentMinor !== 0n,
    hasLimitChange: limitAdjustmentMinor !== 0n,
    flooredToOpenRows: expectedRaw < floor,
  };
}

/** True when this message is older than what has already been applied. */
export function isStaleSequence(appliedSequence: bigint | null, messageSequence: bigint): boolean {
  return appliedSequence !== null && messageSequence <= appliedSequence;
}

/**
 * True when a snapshot describes an earlier moment than one already applied.
 *
 * A higher sequence only means the producer sent it later, not that it
 * describes a later state — a backfill or a re-publish can carry an older
 * `asOf`. Applying it would roll capacity backwards, so freshness is checked on
 * both the sequence and the business timestamp.
 */
export function isStaleSnapshot(appliedAsOf: Date | null, snapshotAsOf: Date): boolean {
  return appliedAsOf !== null && snapshotAsOf.getTime() < appliedAsOf.getTime();
}
