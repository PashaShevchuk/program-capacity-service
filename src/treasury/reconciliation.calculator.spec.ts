import { isStaleSequence, reconcileCapacity } from './reconciliation.calculator';

const base = {
  snapshotReservedMinor: 400_000_00n,
  snapshotLimitMinor: 1_000_000_00n,
  currentReservedMinor: 400_000_00n,
  currentLimitMinor: 1_000_000_00n,
  openedLocallyAfterSnapshotMinor: 0n,
  closedLocallyAfterSnapshotMinor: 0n,
};

describe('reconcileCapacity', () => {
  it('reports no drift when both sides agree', () => {
    const outcome = reconcileCapacity(base);

    expect(outcome.hasDrift).toBe(false);
    expect(outcome.reservedAdjustmentMinor).toBe(0n);
    expect(outcome.expectedReservedMinor).toBe(400_000_00n);
  });

  it('corrects local state towards the snapshot', () => {
    const outcome = reconcileCapacity({ ...base, currentReservedMinor: 380_000_00n });

    expect(outcome.hasDrift).toBe(true);
    expect(outcome.reservedAdjustmentMinor).toBe(20_000_00n);
  });

  it('keeps reservations taken after the snapshot was built', () => {
    const outcome = reconcileCapacity({
      ...base,
      currentReservedMinor: 450_000_00n,
      openedLocallyAfterSnapshotMinor: 50_000_00n,
    });

    // The snapshot has not seen the new 50k yet, so nothing should change.
    expect(outcome.expectedReservedMinor).toBe(450_000_00n);
    expect(outcome.hasDrift).toBe(false);
  });

  it('does not re-add reservations released after the snapshot', () => {
    const outcome = reconcileCapacity({
      ...base,
      currentReservedMinor: 300_000_00n,
      closedLocallyAfterSnapshotMinor: 100_000_00n,
    });

    expect(outcome.expectedReservedMinor).toBe(300_000_00n);
    expect(outcome.hasDrift).toBe(false);
  });

  it('handles reservations opened and released around the snapshot together', () => {
    const outcome = reconcileCapacity({
      ...base,
      currentReservedMinor: 420_000_00n,
      openedLocallyAfterSnapshotMinor: 70_000_00n,
      closedLocallyAfterSnapshotMinor: 50_000_00n,
    });

    expect(outcome.expectedReservedMinor).toBe(420_000_00n);
    expect(outcome.hasDrift).toBe(false);
  });

  it('never drives the reserved total below zero', () => {
    const outcome = reconcileCapacity({
      ...base,
      snapshotReservedMinor: 10_000_00n,
      closedLocallyAfterSnapshotMinor: 90_000_00n,
      currentReservedMinor: 0n,
    });

    expect(outcome.expectedReservedMinor).toBe(0n);
  });

  it('picks up a limit change from the snapshot', () => {
    const outcome = reconcileCapacity({ ...base, snapshotLimitMinor: 1_500_000_00n });

    expect(outcome.hasLimitChange).toBe(true);
    expect(outcome.limitAdjustmentMinor).toBe(500_000_00n);
  });
});

describe('isStaleSequence', () => {
  it('accepts anything when nothing has been applied yet', () => {
    expect(isStaleSequence(null, 1n)).toBe(false);
  });

  it('rejects a sequence already applied or older', () => {
    expect(isStaleSequence(10n, 10n)).toBe(true);
    expect(isStaleSequence(10n, 9n)).toBe(true);
  });

  it('accepts a newer sequence', () => {
    expect(isStaleSequence(10n, 11n)).toBe(false);
  });
});
