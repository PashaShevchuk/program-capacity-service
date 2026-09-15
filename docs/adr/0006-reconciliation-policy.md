# 6. Reconciliation layers local changes over the snapshot

Accepted.

## Context

Treasury periodically sends a program's full capacity state. The naive handling
is to overwrite local state with it. That is wrong in two ways at once.

A snapshot describes the world as at its `asOf` timestamp, but it arrives later.
In between, this service may have accepted reservations treasury has not seen —
overwriting drops them, and that capacity is handed out twice. It may also have
released reservations the snapshot still counts as open — overwriting brings
them back, and that capacity is lost.

Kafka also only guarantees order within a partition, so an older snapshot can
arrive after a newer one.

## Decision

Treat the snapshot as authoritative as at `asOf`, then re-apply what happened
locally afterwards:

```
expected = snapshot reserved
         + reservations opened here after asOf and still open
         - reservations the snapshot counts that we have since closed
```

Only API-sourced reservations count; anything mirrored from treasury is already
in the snapshot's total.

Every message carries a `sequence` that is monotonic per program. Anything at or
below the sequence already applied is discarded.

Any difference that remains between `expected` and the current total is applied
as a `RECONCILIATION_ADJUSTMENT` ledger entry, carrying the snapshot's own
figures and the local sums in its metadata.

The arithmetic is a pure function, `reconcileCapacity`, tested on its own.

## Consequences

In-flight local work survives a snapshot, and a stale snapshot cannot roll state
backwards.

Genuine disagreement is recorded rather than hidden, so an operator can see what
treasury thought, what we thought, and what was done about it.

This relies on `asOf` being comparable with local timestamps, which assumes
clocks are reasonably close. With clocks far apart the honest fix is for the
snapshot to carry treasury's own watermark for what it has received from us.

A snapshot may leave a program overcommitted. The service accepts that and flags
it rather than rejecting the snapshot, because refusing the source of truth
would leave the two permanently out of sync.
