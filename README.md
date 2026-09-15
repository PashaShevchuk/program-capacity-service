# Program Capacity & Invoice Reservation

Tracks how much of a financing program's credit limit is still available, in
real time.

Approving an invoice for early payment reserves part of the limit; repaying it
releases the amount back. Capacity also moves through a Kafka feed from an
external treasury system, which sends both incremental events and periodic
full-state snapshots. Programs and invoices can be in different currencies.

## Running it

Needs Docker and Node 20+ (`.nvmrc` pins 22).

```bash
cp .env.example .env
docker compose up -d          # PostgreSQL, Redpanda, topics, Kafka UI
npm ci
npm run migration:run
npm run seed
npm run start:dev
```

Service on <http://localhost:3000>, Swagger at `/docs`, Kafka UI on `:8080`.
To run everything in containers: `docker compose --profile app up --build`.

### Seeded logins

| Email | Password | Role | Can |
|---|---|---|---|
| `admin@demo.local` | `Admin123!` | admin | everything, incl. creating programs and changing limits |
| `client@demo.local` | `Client123!` | client | reserve, release, read |
| `viewer@demo.local` | `Viewer123!` | viewer | read only |

Also seeded: `PRG-USD-001` ($10,000,000), `PRG-EUR-001` (€5,000,000), and FX
rates.

### Trying it

`requests.http` has a ready request for every endpoint (VS Code REST Client or
JetBrains HTTP client). Or:

```bash
TOKEN=$(curl -s localhost:3000/v1/auth/token \
  -H 'content-type: application/json' \
  -d '{"email":"admin@demo.local","password":"Admin123!"}' | jq -r .accessToken)

# a EUR invoice against a USD program
curl -s -X POST localhost:3000/v1/programs/PRG-USD-001/reservations \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"invoiceId":"INV-1","amount":{"amount":"1000000.00","currency":"EUR"}}'
```

For the Kafka side without a treasury system, `npm run simulate:treasury --
PRG-USD-001` sends a snapshot, a duplicate, an out-of-order one, a treasury
reservation, a malformed message and a limit change — enough to watch
deduplication, the sequence guard and the DLQ work.

## API

Everything under `/v1` needs a bearer token. `/healthz`, `/readyz` and
`/metrics` do not.

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/v1/auth/token` | — | credentials for a JWT |
| `GET` | `/v1/programs` | any | list programs |
| `POST` | `/v1/programs` | admin | create a program |
| `GET` | `/v1/programs/:ref` | any | one program |
| `GET` | `/v1/programs/:ref/capacity` | any | limit, reserved, available |
| `GET` | `/v1/programs/:ref/capacity/stream` | any | SSE stream of changes |
| `PATCH` | `/v1/programs/:ref/limit` | admin | change the credit limit |
| `GET` | `/v1/programs/:ref/ledger` | any | audit trail, cursor-paged |
| `POST` | `/v1/programs/:ref/reservations` | client, admin | reserve for an approved invoice |
| `GET` | `/v1/programs/:ref/reservations` | any | list reservations, cursor-paged |
| `GET` | `/v1/programs/:ref/reservations/:ref` | any | one reservation |
| `POST` | `/v1/programs/:ref/reservations/:ref/release` | client, admin | release after repayment |
| `POST` | `/v1/programs/:ref/reservations/:ref/cancel` | client, admin | withdraw a reservation |

`:ref` takes a UUID or a business code, so `PRG-USD-001` and `INV-2026-000123`
both work. The SSE stream is authenticated like everything else, and the browser
`EventSource` cannot send headers — use a fetch-based reader, or `requests.http`.

Errors are RFC 7807 `application/problem+json` with a stable `code`:

```json
{
  "type": "https://docs.capacity.example/errors/INSUFFICIENT_CAPACITY",
  "title": "Insufficient capacity",
  "status": 409,
  "detail": "Program PRG-USD-001 has 8915000.00 USD available, less than the requested 20000000.00 USD",
  "code": "INSUFFICIENT_CAPACITY",
  "requestId": "062f456b-0da8-452c-af2a-c71bd595e18c",
  "details": { "requestedAmount": "20000000.00", "availableAmount": "8915000.00" }
}
```

## How it works

### Capacity cannot be oversold

Two approvals arriving at once must not both see the same availability and both
succeed. Every capacity movement runs in one transaction that starts by locking
the program row:

```sql
SELECT * FROM programs WHERE code = $1 FOR UPDATE
```

A conditional `UPDATE` would protect the balance alone, but a movement also
writes a reservation, a ledger entry holding the resulting balances, and an
outbox event. The lock gives all four one consistent view. Optimistic retries
would work too, but turn into a retry storm on a busy program.

Only approvals for the same program are serialised, and programs are
independent. `test/integration/capacity-concurrency.spec.ts` fires 50
simultaneous reservations at a limit that fits 33 and asserts exactly 33
succeed.

### Money and currencies

Amounts are integer minor units in `bigint` columns, wrapped in a `Money` value
object. No floating point anywhere, and mixing currencies throws.

On the wire amounts are decimal strings (`"10000000.00"`), never JSON numbers.
More decimal places than the currency has is an error, not something to round.

A USD program can hold a EUR invoice. The amount is converted **once**, at
reservation time, and the result plus the rate is stored on the reservation.
Releasing returns that stored amount and never converts again — otherwise a
rate that moved between approval and repayment would leave the program short or
over.

Rates come from an `ExchangeRateProvider` port; the bundled adapter reads the
`fx_rates` table.

### Kafka messages are applied exactly once

Kafka delivers at least once. Each message is claimed by inserting a row into
`processed_messages` **in the same transaction** as the change it causes, so a
redelivery hits the unique constraint and the whole thing rolls back.

Offsets are committed by hand once a message is applied or parked. A validation
or business error will fail the same way every time, so it goes straight to
`<topic>.dlq` with the error and original offset in the headers; anything else
is retried with backoff first. Either way the partition keeps moving.

### Reconciliation keeps local work

Correcting the total alone is not enough. If a reserve event was lost, the
balance would be right while the reservation behind it was missing, and the
later release would fail with `RESERVATION_NOT_FOUND` — that capacity is stuck.

So when a snapshot lists `openReservations`, the rows are rebuilt from it:
missing ones recreated, ones treasury no longer lists closed. The balance is
then the sum of those rows. One list, one truth.

Without that list there is only timing:

```
expected = max(snapshot + opened after asOf - closed after asOf, open rows)
```

The floor matters because `asOf` is treasury's clock: it cannot say whether
treasury has *received* a reservation accepted a moment earlier, and dropping
below the open rows would hand that capacity out twice. Whether a movement is in
the snapshot is decided by when it happened, not by who created the reservation.

Any difference becomes a `RECONCILIATION_ADJUSTMENT` ledger entry carrying both
sides' figures, so a correction is visible.

Messages carry a per-program `sequence`; anything at or below the one applied is
discarded, since Kafka only orders within a partition. A higher sequence need
not describe a later state, so a snapshot whose `asOf` precedes the applied one
is rejected too. The arithmetic is a pure function, `reconcileCapacity`.

### Events are published through an outbox

PostgreSQL and Kafka cannot share a transaction, so the event is written to
`outbox_messages` alongside the change, and a background publisher claims rows
with `FOR UPDATE SKIP LOCKED` and sends them. At least once, with `eventId` for
consumers to deduplicate on.

### Paging lists that grow while you read them

`/programs` uses offsets: short list, unique sort key.

The ledger and the reservation list grow at the head and are read newest first,
so offsets are wrong twice over: rows shift down as new ones arrive, and the
sort timestamps are not unique, which lets tied rows come back in any order.
Both use a cursor on the row value `(timestamp, id)`, returning `nextCursor` and
`hasMore` instead of a total:

```sql
WHERE program_id = $1 AND (created_at, id) < ($2, $3)
ORDER BY created_at DESC, id DESC
LIMIT $4
```

Those columns are `timestamptz(3)`: PostgreSQL stores microseconds, a JavaScript
`Date` cannot, and a cursor built from the truncated value skipped rows until a
test caught it.

### Everything is auditable

`capacity_ledger_entries` is append-only: the delta, the balances it produced,
who caused it (the authenticated user or the treasury system) and the request or
message id behind it. Nothing updates or deletes rows there.

## Kafka contracts

**`treasury.capacity.events.v1`** (consumed) — `eventType` is
`CapacityReserved`, `CapacityReleased` or `ProgramLimitChanged`:

```json
{
  "eventId": "8a7b...",
  "eventType": "CapacityReserved",
  "programCode": "PRG-USD-001",
  "sequence": 1001,
  "occurredAt": "2026-09-15T10:00:00.000Z",
  "payload": {
    "invoiceId": "TR-77",
    "amount": { "amount": "500000.00", "currency": "EUR" }
  }
}
```

**`treasury.capacity.reconciliation.v1`** (consumed) — full state:

```json
{
  "eventId": "c41d...",
  "programCode": "PRG-USD-001",
  "sequence": 1000,
  "occurredAt": "2026-09-15T10:00:00.000Z",
  "asOf": "2026-09-15T09:59:00.000Z",
  "totalLimit": { "amount": "12000000.00", "currency": "USD" },
  "reservedTotal": { "amount": "2000000.00", "currency": "USD" },
  "openReservations": [
    { "invoiceId": "TR-A", "amount": { "amount": "2000000.00", "currency": "USD" } }
  ]
}
```

`openReservations` is optional, quoted in the program's own currency, and capped
at 2,000 entries. Omitted, it says nothing about individual rows; empty, it says
treasury holds none. When present it must list each invoice once and sum to
`reservedTotal`, or the snapshot is parked in the DLQ rather than half-applied.
`sequence` is a `bigint`; send it as a string above 2^53.

**`program.capacity.changed.v1`** (published) — keyed by program id, carrying
the new limit, reserved and available amounts, the program `version` and the
reason.

Consumed messages that cannot be applied go to `<topic>.dlq`. Outbound events
are different: they sit in `outbox_messages` until they are published, and a row
that exhausts its retries is marked `FAILED` and left for an operator.

## Tests

```bash
npm run test:unit          # fast, no Docker
npm run test:integration   # starts a PostgreSQL container per suite
npm test                   # both
```

129 tests. Unit tests cover money arithmetic and precision, currency conversion
and rounding, the reservation state machine, the reconciliation arithmetic,
treasury sequence validation down to the value `JSON.parse` has already rounded,
and the rule that a message which cannot be parked in the DLQ keeps its offset.

Five integration suites cover what unit tests cannot prove, on a real database:

- **concurrency** — 50 simultaneous reservations against a limit that fits 33;
  interleaved reserves and releases; one ledger entry each, with no gaps or
  repeats in the running balance;
- **HTTP** — authentication and roles, cross-currency reservations, idempotent
  retries and keys reused for a different request, duplicate invoices,
  insufficient capacity, precision and range rules, release, cancel, limit
  changes, and the audit trail naming the acting user;
- **treasury messages** — deduplicated redeliveries, out-of-order sequences and
  `asOf`, rows recreated and closed from a snapshot, a treasury reservation
  released through the API not double-counted, and malformed payloads failing
  permanently;
- **pagination** — every entry served once, entries sharing a timestamp not
  lost, pages stable while new rows are written;
- **reconciliation safety** — the balance never falling below the open rows,
  the capacity that would free not being reservable twice, an invoice the
  snapshot lists counted once, and a restated amount leaving the invoice and its
  frozen rate untouched.

There is no test against a live broker: handlers run through
`KafkaConsumerService.processMessage`, the same path `eachMessage` takes, and
`npm run simulate:treasury` exercises the real wiring.

## Operations

- `GET /healthz` — liveness, touches nothing
- `GET /readyz` — readiness, pings the database
- `GET /metrics` — Prometheus: reservation outcomes, capacity and utilisation
  per program, Kafka message outcomes and timings. Per-program gauges appear
  once that program first moves, and utilisation exceeds 1 on an overcommit
- JSON logs carrying the `x-request-id` on every line. The same id lands on
  ledger entries, so a capacity movement traces back to the request behind it.
  Authorization headers and passwords are redacted.

## Layout

```
src/
  common/        Money, domain errors, RFC 7807 filter, logging, pagination
  config/        typed config, validated at boot
  database/      data source, migrations, seeds
  auth/          JWT strategy, guards, roles
  programs/      program entity, capacity repository (locking), controller
  reservations/  reserve / release / cancel
  ledger/        append-only audit trail
  fx/            rate port, database adapter, pure converter
  kafka/         client, consumer, deduplication, DLQ
  treasury/      message contracts and handlers, reconciliation
  outbox/        transactional outbox and its publisher
  health/ metrics/
scripts/         treasury simulator
```

`Money`, `convertMoney` and `reconcileCapacity` are plain TypeScript with no
framework, which is why they are the easiest parts to test.

Assumptions and trade-offs are in [ASSUMPTIONS.md](ASSUMPTIONS.md).
