# Assumptions and trade-offs

Where the brief left room for interpretation, this is what I chose. README
explains how things work; this file is what I decided and what is missing.

## Domain rules

**An invoice holds at most one reservation per program, ever.** `(program_id,
invoice_id)` is unique, which makes the reservation its own idempotency record.
The cost: a released invoice cannot be financed again under the same program.
Re-financing seemed less likely than a retried approval, and the retry is the
case that corrupts capacity.

**Repeating a release is success, not an error.** Repayment notifications get
retried, and an already-released reservation is the outcome the caller wanted.
Cancelling something already released is still rejected — different outcomes.

**Lowering a limit below what is reserved is refused.** The alternative is a
program reporting negative availability with no way to explain it.

**A program can be overcommitted, but only through treasury.** If a snapshot
reports more reserved than the limit allows, the service accepts it and flags
`overcommitted: true`; rejecting it would leave us permanently out of sync with
the source of truth. So the database enforces `reserved >= 0` but deliberately
not `reserved <= limit`. The API path can never produce an overcommit.

## Reconciliation

**`asOf` is compared against local timestamps,** which assumes clocks are
reasonably close. With clocks far apart, the honest fix is for the snapshot to
carry treasury's own watermark for what it has received from us.

**A local movement counts as unseen by timing, not by who created it.** A
reservation opened after `asOf` is absent from the snapshot whoever opened it,
and one the snapshot counts is gone whoever closed it.

**The reserved total never drops below what the open rows hold.** `asOf` is
treasury's clock and cannot say whether treasury has *received* a reservation
accepted moments earlier, so the snapshot arithmetic is floored by the open
rows. The cost is that a program can sit temporarily over-reserved; the
alternative is handing the same capacity out twice. Removing this floor safely
needs an acknowledgement watermark in the contract — treasury telling us which
of our events it has taken in — rather than a timestamp.

**A residual difference is recorded, not applied silently.** It becomes a ledger
entry carrying both sides' figures.

**`openReservations` is quoted in the program's own currency.** The snapshot
carries no FX rate, so there would be nothing to convert a foreign amount with.
A snapshot that breaks this is rejected rather than guessed at.

**A snapshot that still lists an invoice we have released leaves it closed.** We
hold an explicit release for it and treasury has not caught up. Resurrecting a
repaid invoice is the worse failure.

**Incremental treasury reserves may overcommit a program.** They report what
already happened at the source of truth, so refusing one would leave the two
permanently out of step. A snapshot can overcommit a program for the same
reason. The API path can never do it, and `overcommitted` is exposed on the
capacity endpoint.

**Reconciliation closes a dropped reservation as `CANCELLED`.** A treasury
release arriving afterwards is accepted as already applied rather than rejected
as an invalid transition.

**A sequence gap is not detected.** If a message is parked in the DLQ and a
later one succeeds, the watermark moves past the gap and the parked message can
no longer be replayed — it will be discarded as stale. Closing this properly
needs a contract the producer takes part in: an expected-sequence field, or a
watermark from treasury saying what it has received from us, so the service can
tell a gap from a reordering. Building half of it here would give false
confidence. Until then, recovery from a parked message goes through the next
snapshot, which is why snapshots now rebuild reservation rows rather than only
the total.

## Money and FX

**Conversions round up.** Fractions of a minor unit go against the borrower, so
repeated conversions can never manufacture capacity.

**Over-precise amounts are rejected, not rounded.** Turning a client's `10.005`
into `10.01` would make our books disagree with theirs.

**Only the currencies listed in `CURRENCY_EXPONENTS` are accepted.** An unknown
code is rejected rather than given an assumed two-decimal exponent.

**Rates are seeded into `fx_rates`, standing in for the treasury rate feed.** A
missing pair is a 409, not a guessed rate.

**Rates are not cached.** The indexed lookup is cheap at this volume, and
caching would need an invalidation story that is not worth inventing without a
real provider.

## Authentication

**Local credentials with HS256 JWTs,** so the service runs with `docker compose
up` and no external dependency. A real deployment replaces the users table with
an identity provider, points `JwtStrategy` at its JWKS and moves to RS256. The
seams are all inside `AuthModule`.

**All routes are authenticated by default.** The global guard is opt-out via
`@Public()`, so a forgotten decorator fails closed.

**Three coarse roles.** Admin manages programs and limits, client moves
capacity, viewer reads. Per-program authorisation is not modelled; it would be
the first thing to add for a multi-tenant deployment.

**The acting user is recorded on ledger entries, not on reservations.** The
ledger already covers both taking and returning capacity. The label is
snapshotted rather than joined, because an email can change later and the audit
line should not change with it.

**`/metrics` is unauthenticated,** assuming it is not exposed outside the
cluster.

## Pagination

**Cursor responses carry no total.** Avoiding `COUNT(*)` on an unbounded table
is most of the reason to use a cursor. A client needing an exact count would
need a separate endpoint.

**Cursors are opaque but not signed.** They encode a timestamp and an id in
base64. A crafted one only reads from a different point in a list the caller can
already see. If cursors ever carried filter state, they would need signing.

## Operational limits

**Migrations run on boot.** Convenient for one instance; with several replicas
this should become a deploy-time job so they do not race. Controlled by
`DB_RUN_MIGRATIONS_ON_BOOT`.

**The SSE stream is per instance.** A client connected to one replica will not
see changes applied by another. Cluster-wide delivery means consuming the
`program.capacity.changed` topic the service already publishes. Kept simple
because it is a convenience on top of the API, not the source of truth.

**The outbox publisher polls every second.** Fine at this volume; reading the
WAL would be the next step if latency mattered.

**Outbox rows that exhaust their retries are marked `FAILED` and kept** for an
operator. There is no endpoint to replay them; that is worth adding.

**No rate limiting, CORS configuration or request size limits** beyond the
defaults. Deployment concerns here, but real decisions before going live.

## Testing

**No test against a live broker.** Handlers are driven through
`KafkaConsumerService.processMessage`, the same path `eachMessage` takes, so a
broker would add start-up time and flakiness without covering more.
`npm run simulate:treasury` exercises the real wiring by hand.

**Integration tests start their own PostgreSQL container** rather than relying
on a running compose stack, so they are self-contained and safe in CI.

## Security not covered here

**No TLS or SASL on Kafka, and no SSL on PostgreSQL.** Local development runs on
a private network. Both are configuration rather than code changes, but they
would be required before any real deployment.

**No rate limiting on the token endpoint.** Login is constant-cost — a missing
user is compared against a real bcrypt hash so it takes as long as a wrong
password — but nothing limits how often it can be tried.

**Ledger append-only is a convention, not a database grant.** The service never
updates or deletes those rows, but the role it connects with could. A production
deployment would use a role without UPDATE or DELETE on that table, or a trigger
that refuses them.

**No retention on `processed_messages` or published outbox rows.** Both grow
without bound. The inbox has to be kept longer than the broker's replay window,
which makes the retention period a deployment decision rather than a default.

## Not built

Multi-tenancy, per-program authorisation, partial releases, reservation expiry,
fees or interest, an admin UI, and DLQ replay tooling. Each is a reasonable next
step; none is needed to show the behaviour the brief asks for.
