# Assumptions and trade-offs

Where the brief left room for interpretation, this is what I chose. README says
how things work; this says what I decided and what is missing.

## Domain

**An invoice holds at most one reservation per program, ever.** `(program_id,
invoice_id)` is unique, which makes the reservation its own idempotency record.
The cost: a released invoice cannot be financed again under the same id.

**Repeating a release is success, not an error** — repayment notifications get
retried. Cancelling something already released is still rejected.

**Lowering a limit below what is reserved is refused.** Release first.

**A program can be overcommitted, but only through treasury.** Its snapshots and
events report what already happened, so refusing them would leave the two
permanently out of step. The database enforces `reserved >= 0` but deliberately
not `reserved <= limit`; the API path can never overcommit, and `overcommitted`
is exposed on the capacity endpoint.

## Reconciliation

**A snapshot listing `openReservations` is taken at its word,** and the balance
becomes the sum of the reconciled rows. Those amounts are quoted in the
program's currency, since the snapshot carries no rate to convert anything else
with, and at most 2,000 per message, since each costs a write inside the program
lock.

**Without that list, timing decides what the snapshot has seen — and the total
never drops below what the open rows hold.** `asOf` is treasury's clock and
cannot say whether treasury has *received* a reservation accepted moments
earlier. The floor can leave a program temporarily over-reserved; dropping below
it would hand the same capacity out twice. Sending the list avoids the question.

**A snapshot that still lists an invoice we have released leaves it closed.** We
hold explicit evidence of the release; resurrecting a repaid invoice is worse.

**Restating an amount changes what is held, not what was agreed.** The invoice
value and the rate frozen at approval stay as recorded; the previous figure goes
to the reservation's metadata and the reason to the ledger.

**A sequence gap is not detected.** If a message is parked in the DLQ and a later
one succeeds, the watermark moves past it and a replay is discarded as stale.
Closing this needs the producer's help — an expected-sequence field, or a
watermark saying what treasury has taken in from us. Until then recovery goes
through the next snapshot, which is why snapshots rebuild rows and not just the
total.

## Money and FX

**Conversions round up,** so repeated conversions cannot manufacture capacity.

**Over-precise amounts are rejected rather than rounded,** and only the
currencies in `CURRENCY_EXPONENTS` are accepted.

**Rates are seeded into `fx_rates`, standing in for the treasury feed.** A
missing pair is a 409, not a guess. Nothing is cached: the lookup is cheap, and
an invalidation story is not worth inventing without a real provider.

## Authentication

**Local credentials with HS256 JWTs,** so the service runs with `docker compose
up`. A real deployment swaps the users table for an identity provider and points
`JwtStrategy` at its JWKS; the seams are inside `AuthModule`.

**All routes are authenticated by default** — the global guard is opt-out via
`@Public()`, so a forgotten decorator fails closed. `/healthz`, `/readyz` and
`/metrics` are public, the last assuming it is not exposed outside the cluster.

**Three coarse roles.** Per-program authorisation is not modelled; it is the
first thing to add for multi-tenancy.

**The acting user is recorded on ledger entries, not on reservations.** The label
is snapshotted rather than joined, because an email can change later.

## Pagination

**Cursor responses carry no total** — avoiding `COUNT(*)` on an unbounded table
is most of the reason to use a cursor.

**Cursors are opaque but not signed.** A crafted one only reads from a different
point in a list the caller can already see.

## Operational limits

**Migrations run on boot.** With several replicas this belongs in a deploy job;
controlled by `DB_RUN_MIGRATIONS_ON_BOOT`.

**The SSE stream is per instance.** Cluster-wide delivery means consuming the
`program.capacity.changed` topic the service already publishes.

**The outbox publisher polls every second and holds its transaction across the
Kafka write.** Fine at this volume; it costs lock time and can duplicate on a
publish-then-rollback, which consumers already deduplicate on `eventId`.

**Outbox rows that exhaust their retries are marked `FAILED` and kept** for an
operator. There is no replay endpoint.

**No retention on `processed_messages` or published outbox rows.** The inbox has
to outlive the broker's replay window, which makes it a deployment decision.

**Gzip and Snappy are the compression codecs supported.** LZ4 and zstd would
each need another dependency, and zstd's is a native build. A batch in an
unsupported codec stops the consumer rather than failing one message, which is
why `/readyz` reports consumer state.

## Security not covered

No Kafka TLS or SASL, no PostgreSQL SSL, no rate limiting on the token endpoint
(login is constant-cost but unthrottled), and no CORS or request-size policy
beyond the defaults.

**Ledger append-only is a convention, not a grant.** Production would use a role
without UPDATE or DELETE on that table.

**`npm audit` is gated on production dependencies only,** which is clean. The
full audit reports findings that reach the tree through Testcontainers and never
ship.

## Testing

**No test against a live broker.** Handlers run through
`KafkaConsumerService.processMessage`, the same path `eachMessage` takes.
`npm run simulate:treasury` exercises the real wiring by hand.

**Integration tests start their own PostgreSQL container,** so they are
self-contained and safe in CI.

## Not built

Multi-tenancy, per-program authorisation, partial releases, reservation expiry,
fees or interest, an admin UI, and DLQ replay tooling.
