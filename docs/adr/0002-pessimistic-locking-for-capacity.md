# 2. Capacity changes take a row lock on the program

Accepted.

## Context

Two invoices approved at the same instant must not both see the same
availability and both succeed. Read-check-write in application code cannot
prevent this; the check and the write have to be atomic with respect to other
writers.

The options were:

1. an atomic conditional update —
   `UPDATE ... SET reserved = reserved + $1 WHERE reserved + $1 <= limit`;
2. optimistic concurrency — read a version, write only if it has not changed,
   retry on conflict;
3. a pessimistic row lock — `SELECT ... FOR UPDATE` for the whole transaction.

## Decision

A pessimistic row lock on the program, held for the transaction.

The conditional update is correct for the balance alone, but a capacity
movement writes more than the balance: it also inserts a reservation, a ledger
entry carrying the *resulting* balances, and an outbox event. Holding the lock
gives all of them one consistent view without a second read.

Optimistic retries would work, but under real contention on a single hot
program they turn into a retry storm, and the retry loop is more code to get
wrong than the lock.

The update still repeats the invariant in its `WHERE` clause and fails loudly if
it affects no rows, so a future caller that forgets to lock corrupts nothing.

## Consequences

Movements on one program are serialised. Since programs are independent, this
costs only the throughput of a single program, which approvals do not come close
to saturating.

Reads are unaffected: `GET /capacity` reads the materialised total without a
lock and PostgreSQL MVCC gives it a consistent snapshot.

Long transactions would now block approvals, so the FX lookup happens before the
transaction opens.

`test/integration/capacity-concurrency.spec.ts` is the proof: 50 simultaneous
reservations against a limit that fits 33.
