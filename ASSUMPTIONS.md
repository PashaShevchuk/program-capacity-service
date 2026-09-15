# Assumptions and trade-offs

Where the brief left room for interpretation, this is what I chose and why.

## Domain

**An invoice holds at most one reservation per program, ever.** `(program_id,
invoice_id)` is unique, which makes the reservation its own idempotency record.
The cost is that an invoice which was released cannot be financed again under
the same program; it would need a new invoice id. Re-financing the same invoice
seemed less likely than a retried approval, and the retry case is the one that
corrupts capacity.

**Releasing returns the amount that was taken, not a fresh conversion.** The
program-currency amount and the FX rate are frozen on the reservation. Without
this, a rate that moves between approval and repayment leaves the program
permanently short or over.

**Repeating a release is success, not an error.** Repayment notifications get
retried. A reservation already released is the outcome the caller wanted, so
the existing record comes back with 200 and no second ledger entry. Cancelling
something already released is still rejected — those are different outcomes.

**Lowering a limit below what is reserved is refused.** The alternative is a
program reporting negative availability with no way to explain it. Release
first, then lower.

**A program can be overcommitted, but only through treasury.** If a snapshot
says more is reserved than the limit allows, the service accepts it and flags
`overcommitted: true`. Rejecting the snapshot would leave us permanently out of
sync with the source of truth. The database therefore enforces
`reserved >= 0` but deliberately not `reserved <= limit`; the API path can
never produce an overcommit.

## Reconciliation

**Treasury is authoritative as at the snapshot's `asOf`, not as at the moment
it arrives.** Local changes made after that timestamp are layered back on top,
as described in the README. This assumes clocks are close enough for `asOf` to
be comparable with local timestamps. With clocks far apart, the honest fix is
for the snapshot to carry treasury's own watermark for what it has seen from us
rather than a wall-clock time.

**Only API-sourced reservations are layered back.** Anything mirrored from
treasury is already in the snapshot's total.

**Ordering is by an explicit `sequence`, not by timestamp or offset.** Kafka
orders within a partition only. A message at or below the applied sequence is
dropped, so a replay of old messages cannot roll state backwards.

**A residual difference is an adjustment, not an overwrite.** It is written to
the ledger with the snapshot's figures attached, so an operator can see what
treasury thought and what we thought.

## Money and FX

**`bigint` minor units everywhere, decimal strings on the wire.** No floats, no
JSON numbers for money.

**Over-precise amounts are rejected, not rounded.**

**Conversions round up.** Fractions of a minor unit go against the borrower, not
the program, so repeated conversions cannot manufacture capacity.

**Rates come from the database, seeded locally.** This stands in for the
treasury rate feed. `ExchangeRateProvider` is the seam for a live provider. A
missing pair is a 409 rather than a guessed rate.

**Rates are not cached.** Every reservation reads the current rate. At this
volume the indexed lookup is cheap; caching would need an invalidation story
that is not worth inventing without a real provider.

**Only the currencies in `CURRENCY_EXPONENTS` are accepted.** Unknown codes are
rejected rather than given an assumed two-decimal exponent.

## Authentication

**Local credentials with HS256 JWTs.** This keeps the service runnable with
`docker compose up` and no external dependency. In a real deployment the users
table gives way to the organisation's identity provider, `JwtStrategy` points
at its JWKS, and the algorithm becomes RS256. The seams are all in `AuthModule`.

**All routes are authenticated by default.** The global guard is opt-out via
`@Public()`, so forgetting a decorator fails closed. Only `/healthz`, `/readyz`,
`/metrics` and the token endpoint are public.

**Three coarse roles.** Admin manages programs and limits, client moves
capacity, viewer reads. Per-program authorisation — who may touch which program
— is not modelled; it would be the first thing to add for a multi-tenant
deployment.

**The acting user is recorded on ledger entries, not on reservations.** The
ledger is the audit record and already covers both taking and returning
capacity, so a second copy on the reservation would be one more thing to keep in
step. The label is snapshotted rather than joined, because an email can change
after the fact and the audit line should not change with it.

**`/metrics` is unauthenticated,** on the assumption that it is not exposed
outside the cluster.

## Concurrency

**A pessimistic row lock per program, not optimistic retries.** Contention is
per program and approvals are not a high-frequency path, so serialising them is
simpler to reason about than a retry loop, and it lets the ledger record an
accurate running balance in the same transaction. The version check in the
update is defence in depth for a future caller that forgets to lock.

**Reads are not blocked by writes.** `GET /capacity` reads the materialised
total without a lock; PostgreSQL MVCC gives it a consistent snapshot.

## Operations

**Migrations run on boot.** Convenient for one instance and for `docker compose
up`; with several replicas this should become a deploy-time job so instances do
not race. Controlled by `DB_RUN_MIGRATIONS_ON_BOOT`.

**The SSE stream is per instance.** A client connected to one replica will not
see changes applied by another. Cluster-wide delivery means consuming the
`program.capacity.changed` topic the service already publishes, or a Redis
channel. Kept simple because it is a convenience on top of the API, not the
source of truth.

**The outbox publisher polls every second.** Fine at this volume; a
logical-replication reader would be the next step if latency mattered.

**Failed outbox rows stop after `OUTBOX_MAX_ATTEMPTS` and are marked `FAILED`.**
They stay in the table for an operator rather than being dropped. There is no
admin endpoint to replay them; that would be worth adding.

**No rate limiting, no CORS configuration, no request size limits beyond the
defaults.** All are deployment concerns here rather than service concerns, but
they would need to be decided before this went live.

## Testing

**No test against a live broker.** Handlers are driven through
`KafkaConsumerService.processMessage`, the same path `eachMessage` takes, so the
deduplication and transaction behaviour is covered. A broker would add start-up
time and flakiness without covering more. `npm run simulate:treasury` exercises
the real wiring by hand.

**Integration tests start their own PostgreSQL container** rather than relying
on a running compose stack, so they are self-contained and safe to run in CI.

## Scope

Not built, and deliberately so: multi-tenancy, per-program authorisation,
partial releases, reservation expiry, scheduled fees or interest, an admin UI,
and replay tooling for the DLQ. Each is a reasonable next step; none is needed
to show the behaviour the brief asks for.
