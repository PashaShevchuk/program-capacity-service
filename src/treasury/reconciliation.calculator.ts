/**
 * Works out what a program's reserved total should be after a treasury
 * reconciliation snapshot, and how far the local figure had drifted.
 *
 * The snapshot is authoritative as at `asOf`, but it is not the whole picture:
 * this service may have accepted reservations after that moment which treasury
 * has not seen yet, and it may have released reservations that the snapshot
 * still counts as open. Overwriting with the raw snapshot total would drop the
 * first group and double-count the second.
 *
 *   expected = snapshot
 *            + reservations opened here after asOf and still open
 *            - reservations the snapshot counts that we have since closed
 *
 * Kept pure so the arithmetic can be tested without a database.
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
}

export interface ReconciliationOutcome {
  expectedReservedMinor: bigint;
  /** Applied to the program to bring it in line. */
  reservedAdjustmentMinor: bigint;
  limitAdjustmentMinor: bigint;
  hasDrift: boolean;
  hasLimitChange: boolean;
}

export function reconcileCapacity(input: ReconciliationInput): ReconciliationOutcome {
  const expectedRaw =
    input.snapshotReservedMinor +
    input.openedLocallyAfterSnapshotMinor -
    input.closedLocallyAfterSnapshotMinor;

  // Treasury and local state disagreeing badly enough to produce a negative
  // total means one side is wrong; zero is the only defensible floor, and the
  // adjustment entry records that it happened.
  const expectedReservedMinor = expectedRaw < 0n ? 0n : expectedRaw;

  const reservedAdjustmentMinor = expectedReservedMinor - input.currentReservedMinor;
  const limitAdjustmentMinor = input.snapshotLimitMinor - input.currentLimitMinor;

  return {
    expectedReservedMinor,
    reservedAdjustmentMinor,
    limitAdjustmentMinor,
    hasDrift: reservedAdjustmentMinor !== 0n,
    hasLimitChange: limitAdjustmentMinor !== 0n,
  };
}

/** True when this message is older than what has already been applied. */
export function isStaleSequence(appliedSequence: bigint | null, messageSequence: bigint): boolean {
  return appliedSequence !== null && messageSequence <= appliedSequence;
}
